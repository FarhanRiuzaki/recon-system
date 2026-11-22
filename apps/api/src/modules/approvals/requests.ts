// The runtime of the approval workflow engine (DEC-052 rev 2): a request takes the workflow version its recon's
// published version pins for the change (the first rule whose condition holds on the break, else the default
// workflow, else the default chain), snapshotted with its names; its levels pass in order, a level
// when every group in it has its approvals from people eligible now (the one who asked and anyone who decided this
// request already never count: one decision per person per request). One reject ends it; the one who asked may cancel
// while it waits; a Superadmin approves what is left only by override, with a reason, and never their own request.
// The owning module does the change when the last level passes and undoes the wait on a reject or cancel, in the
// same transaction (engine: applyBreakChange, revertBreakRequest).
import { type Context, evaluate } from "@starterkit/shared/conditions";
import type { ReconApprovalSpec } from "@starterkit/shared/contracts/recon";
import type { PreviewDto, RequestViewDto } from "@starterkit/shared/contracts/workflows";
import type { ApproveBody, OverrideBody, RejectBody } from "@starterkit/shared/contracts/workflows";
import { isSuperadmin } from "@starterkit/shared/permissions";
import { ROLE_LABEL } from "@starterkit/shared/spaces";
import { type Attributes, type Chain, DEFAULT_CHAIN, type Group, groupNeeds, type Level, type Trigger } from "@starterkit/shared/workflows";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { InTx } from "../../kernel/db";
import { ApiError, isUniqueViolation, notFound } from "../../kernel/errors";
import { recordActivity } from "../audit";
import type { Ctx } from "../auth";
import { applyBreakChange, revertBreakRequest } from "../engine";
import { type ActionEvent, enqueueActions } from "../integrations";
import { reconConfigs, reconConfigVersions } from "../recon";
import { roles, userRoles } from "../rbac";
import { spaceMembers, withSpace } from "../spaces";
import { users } from "../users";
import { approvalDecisions, approvalRequests } from "./schema";
import { pinnedVersion } from "./workflows";

type Person = { id: string; name: string | null };
type RequestRow = typeof approvalRequests.$inferSelect;
type DecisionRow = typeof approvalDecisions.$inferSelect;
const inSpace = <T>(ctx: Ctx, fn: (tx: InTx, spaceId: string) => Promise<T>) =>
  withSpace({ spaceIds: [ctx.space!.id], userId: ctx.user.id }, (tx) => fn(tx, ctx.space!.id));

/**
 * The active people a group names now (its space roles in this space, its global roles, its users), minus `exclude`;
 * only members of the space count (any role): nobody approves in a space they can't open (DEC-052 revision §4.2).
 */
export async function approversOf(tx: InTx, spaceId: string, g: Group, exclude: ReadonlySet<string>): Promise<Person[]> {
  const ids = new Set<string>();
  if (g.spaceRoles.length) for (const r of await tx.select({ id: spaceMembers.userId }).from(spaceMembers).where(and(eq(spaceMembers.spaceId, spaceId), inArray(spaceMembers.role, g.spaceRoles)))) ids.add(r.id);
  if (g.globalRoles.length) for (const r of await tx.select({ id: userRoles.userId }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(inArray(roles.name, g.globalRoles))) ids.add(r.id);
  for (const u of g.users) ids.add(u);
  for (const x of exclude) ids.delete(x);
  if (!ids.size) return [];
  const members = tx.select({ id: spaceMembers.userId }).from(spaceMembers).where(eq(spaceMembers.spaceId, spaceId));
  return tx.select({ id: users.id, name: users.name }).from(users)
    .where(and(inArray(users.id, [...ids]), inArray(users.id, members), eq(users.isActive, true))).orderBy(sql`lower(${users.name})`);
}

/** A group in words: "Reviewer, Space admin, Budi". */
export function groupText(g: Group, names: ReadonlyMap<string, string | null>): string {
  return [...g.spaceRoles.map((r) => ROLE_LABEL[r]), ...g.globalRoles, ...g.users.map((u) => names.get(u) ?? "a removed user")].join(", ");
}
const needText = (g: Group) => (g.need.kind === "any" ? "1 of" : g.need.kind === "all" ? "all of" : `${g.need.n} of`);

type Resolved = { chain: Chain; versionId: string | null; workflow: { id: string; name: string; version: number } | null; rule: { name: string; index: number | null } };
/** Why a request is refused when its approval setup pins a workflow version that is gone. */
export const MISSING_WORKFLOW = "The approval setup of this recon points to a workflow version that no longer exists. Ask a config maker to fix the recon.";
/**
 * The chain an approval setup gives a change on `context`: the first rule whose condition holds, else the default
 * workflow ("Every request"), else the default chain ("Default"). A pinned version that is gone is 409.
 */
export async function resolveChain(tx: InTx, spaceId: string, approvals: ReconApprovalSpec | undefined, kind: Trigger, context: Context): Promise<Resolved> {
  const w = approvals?.changes[kind]?.workflow;
  const i = w ? w.rules.findIndex((r) => evaluate(r.when, context)) : -1;
  const ref = i >= 0 ? w!.rules[i]!.workflow : w?.default ?? null;
  if (!ref) return { chain: DEFAULT_CHAIN, versionId: null, workflow: null, rule: { name: "Default", index: null } };
  const v = await pinnedVersion(tx, spaceId, ref);
  if (!v) throw new ApiError("invalid_state", MISSING_WORKFLOW);
  return { chain: v.spec, versionId: v.id, workflow: { id: ref.id, name: v.name, version: ref.version }, rule: i >= 0 ? { name: w!.rules[i]!.name, index: i } : { name: "Every request", index: null } };
}

/** The recon's published version (its id, approval setup) and code, for a request's rules. */
async function liveSetup(tx: InTx, spaceId: string, configId: string) {
  const [v] = await tx.select({ id: reconConfigVersions.id, spec: reconConfigVersions.spec, code: reconConfigs.code }).from(reconConfigVersions)
    .innerJoin(reconConfigs, eq(reconConfigs.id, reconConfigVersions.configId))
    .where(and(eq(reconConfigVersions.spaceId, spaceId), eq(reconConfigVersions.configId, configId), eq(reconConfigVersions.status, "published")));
  return v ? { id: v.id, code: v.code, approvals: (v.spec as { approvals?: ReconApprovalSpec }).approvals } : null;
}

/**
 * Open a request for a change (called by the owning module inside its transaction): its chain from the recon's
 * pinned workflow by its rules on `context`, refused when a level could never pass (nobody besides the one who asks).
 */
export async function openRequest(tx: InTx, ctx: Ctx, r: {
  kind: Trigger; configId: string; itemId: string; itemIds: string[]; label: string; note: string; prevState: string | null; attributes: Attributes; context: Context;
}): Promise<string> {
  const spaceId = ctx.space!.id;
  const live = await liveSetup(tx, spaceId, r.configId);
  const { chain, versionId, workflow, rule } = await resolveChain(tx, spaceId, live?.approvals, r.kind, { ...r.context, "recon.code": live?.code ?? null });
  const configVersionId = live?.id ?? null, ruleName = rule.name;
  const me = new Set([ctx.user.id]);
  for (const [i, level] of chain.levels.entries()) {
    for (const g of level.groups) {
      const n = (await approversOf(tx, spaceId, g, me)).length;
      if (groupNeeds(g.need, n, 0).short) {
        throw new ApiError("invalid_state", `Level ${i + 1}${level.name ? ` (${level.name})` : ""} of ${versionId ? `the “${chain.name}” workflow` : "the default chain"} has nobody else who can approve it. ${versionId ? "Ask a space admin or a workflow manager to fix it." : "Ask a space admin to add a reviewer."}`);
      }
    }
  }
  const id = Bun.randomUUIDv7();
  try {
    await tx.insert(approvalRequests).values({
      id, spaceId, configId: r.configId, kind: r.kind, itemId: r.itemId, itemIds: r.itemIds, label: r.label, note: r.note, prevState: r.prevState,
      requestedBy: ctx.user.id, attributes: r.attributes, workflowVersionId: versionId, configVersionId, workflowName: workflow?.name ?? null,
      ruleName, chain: chain.levels, currentLevel: 0,
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw new ApiError("invalid_state", "A change of this item already waits for a decision.");
    throw e;
  }
  return id;
}

/** Who would approve a change of a recon version on typed `values` (the setup step's preview; nothing is written). */
export async function previewApproval(tx: InTx, spaceId: string, configId: string, approvals: ReconApprovalSpec | undefined, kind: Trigger, values: Context): Promise<PreviewDto> {
  const [c] = await tx.select({ code: reconConfigs.code }).from(reconConfigs).where(and(eq(reconConfigs.spaceId, spaceId), eq(reconConfigs.id, configId)));
  const { chain, workflow, rule } = await resolveChain(tx, spaceId, approvals, kind, { "recon.code": c?.code ?? null, ...values });
  const none = new Set<string>();
  const levels = await Promise.all(chain.levels.map(async (l, i) => ({
    name: l.name || `Level ${i + 1}`,
    groups: await Promise.all(l.groups.map(async (g) => {
      const approvers = await approversOf(tx, spaceId, g, none);
      return { need: g.need, approvers, short: groupNeeds(g.need, approvers.length, 0).short };
    })),
  })));
  return { rule, workflow, levels };
}

/** The pending request of a subject (a break), if any. */
export async function pendingOf(tx: InTx, spaceId: string, itemId: string): Promise<RequestRow | null> {
  const [rq] = await tx.select().from(approvalRequests).where(and(eq(approvalRequests.spaceId, spaceId), eq(approvalRequests.itemId, itemId), eq(approvalRequests.status, "pending")));
  return rq ?? null;
}

/** Where each group of the current level stands, from the decisions so far and who is eligible now. */
async function levelState(tx: InTx, spaceId: string, rq: RequestRow, decisions: DecisionRow[], level: number) {
  const chain = rq.chain as Level[];
  const lv = chain[level];
  if (!lv) return [];
  const decided = new Set([...(rq.requestedBy ? [rq.requestedBy] : []), ...decisions.map((d) => d.userId)]);
  return Promise.all(lv.groups.map(async (g, gi) => {
    const approvals = decisions.filter((d) => d.level === level && d.groupIndex === gi && d.decision === "approve" && !d.override);
    const approvers = await approversOf(tx, spaceId, g, decided);
    const { left, short } = groupNeeds(g.need, approvers.length, approvals.length);
    return { g, gi, approvals, approvers, left, short };
  }));
}

/** Why the caller can't decide `rq` now, or null. */
async function blockedFor(tx: InTx, ctx: Ctx, rq: RequestRow, decisions: DecisionRow[]): Promise<string | null> {
  if (rq.status !== "pending") return `This request is ${rq.status}.`;
  if (rq.requestedBy === ctx.user.id) return "You asked for this. Someone else in the chain decides it.";
  if (decisions.some((d) => d.userId === ctx.user.id)) return "You decided this request already. Each person decides one level.";
  const state = await levelState(tx, rq.spaceId, rq, decisions, rq.currentLevel);
  if (state.some((s) => s.left > 0 && s.approvers.some((p) => p.id === ctx.user.id))) return null;
  const lv = (rq.chain as Level[])[rq.currentLevel];
  const names = new Map((await peopleOf(tx, (rq.chain as Level[]).flatMap((l) => l.groups.flatMap((g) => g.users)))).map((p) => [p.id, p.name]));
  const waiting = state.filter((s) => s.left > 0).map((s) => `${needText(s.g)} ${groupText(s.g, names)}`).join(" and ");
  return `Level ${rq.currentLevel + 1}${lv?.name ? ` (${lv.name})` : ""} waits for ${waiting || "the people it names"}.`;
}

async function peopleOf(tx: InTx, ids: readonly string[]): Promise<Person[]> {
  const uniq = [...new Set(ids)];
  return uniq.length ? tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, uniq)) : [];
}

/** A request as its subject's page shows it: the chain level by level, who decided, what the caller may do. */
export async function requestView(tx: InTx, ctx: Ctx, rq: RequestRow): Promise<RequestViewDto> {
  const decisions = await tx.select().from(approvalDecisions).where(eq(approvalDecisions.requestId, rq.id)).orderBy(approvalDecisions.at);
  const chain = rq.chain as Level[];
  const names = new Map((await peopleOf(tx, [...decisions.map((d) => d.userId), ...(rq.requestedBy ? [rq.requestedBy] : [])])).map((p) => [p.id, p.name]));
  const person = (id: string | null): Person | null => (id ? { id, name: names.get(id) ?? null } : null);
  const rejected = decisions.find((d) => d.decision === "reject");
  const override = decisions.find((d) => d.override);
  const levels = await Promise.all(chain.map(async (lv, i) => {
    const state = await levelState(tx, rq.spaceId, rq, decisions, i);
    const st = rejected?.level === i ? "rejected" as const
      : rq.status === "approved" || i < rq.currentLevel ? "done" as const
        : i === rq.currentLevel && rq.status === "pending" ? "waiting" as const : "next" as const;
    return {
      name: lv.name, state: st,
      groups: state.map((s) => ({
        need: s.g.need.kind === "count" ? { kind: "count" as const, n: s.g.need.n } : { kind: s.g.need.kind },
        approvals: s.approvals.map((d) => ({ user: person(d.userId)!, at: d.at.toISOString(), note: d.note })),
        left: st === "done" ? 0 : s.left, approvers: s.approvers, short: st !== "done" && s.short,
      })),
    };
  }));
  const pending = rq.status === "pending";
  return {
    id: rq.id, kind: rq.kind as Trigger, status: rq.status as RequestViewDto["status"], note: rq.note, ruleName: rq.ruleName, workflowName: rq.workflowName,
    requester: person(rq.requestedBy), requestedAt: rq.requestedAt.toISOString(), currentLevel: rq.currentLevel, levels,
    rejection: rejected ? { user: person(rejected.userId)!, at: rejected.at.toISOString(), note: rejected.note, level: rejected.level } : null,
    override: override ? { user: person(override.userId)!, at: override.at.toISOString(), reason: override.note ?? "" } : null,
    blocked: await blockedFor(tx, ctx, rq, decisions),
    canOverride: pending && isSuperadmin(ctx.user.roles) && rq.requestedBy !== ctx.user.id,
    canCancel: pending && rq.requestedBy === ctx.user.id,
  };
}

/** Whether the caller may decide each of `rqs` now (the inbox's "Waiting for my decision"). */
export async function decidable(tx: InTx, ctx: Ctx, rqs: RequestRow[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  for (const rq of rqs) {
    const decisions = await tx.select().from(approvalDecisions).where(eq(approvalDecisions.requestId, rq.id));
    out.set(rq.id, await blockedFor(tx, ctx, rq, decisions));
  }
  return out;
}

/** The request `id` of the space, locked, with its decisions. */
async function locked(tx: InTx, spaceId: string, id: string) {
  const [rq] = await tx.select().from(approvalRequests).where(and(eq(approvalRequests.spaceId, spaceId), eq(approvalRequests.id, id))).for("update");
  if (!rq) throw notFound("request");
  const decisions = await tx.select().from(approvalDecisions).where(eq(approvalDecisions.requestId, rq.id));
  return { rq, decisions };
}
const target = (rq: RequestRow) => ({ type: "break", id: rq.itemId, label: rq.label });
const insertDecision = (tx: InTx, rq: RequestRow, d: { level: number; groupIndex: number | null; userId: string; decision: "approve" | "reject"; note?: string | null; override?: boolean }) =>
  tx.insert(approvalDecisions).values({ id: Bun.randomUUIDv7(), spaceId: rq.spaceId, requestId: rq.id, level: d.level, groupIndex: d.groupIndex, userId: d.userId, decision: d.decision, note: d.note ?? null, override: d.override ?? false });

/** The last level passed (or an override): the change happens now, by the caller; the request is approved. */
async function finish(tx: InTx, ctx: Ctx, rq: RequestRow, note: string | null) {
  const done = await applyBreakChange(tx, ctx, rq);
  await tx.update(approvalRequests).set({ status: "approved", decidedBy: ctx.user.id, decidedAt: sql`now()`, decisionNote: note }).where(eq(approvalRequests.id, rq.id));
  return done;
}

/** POST …/approval-requests/{id}/approve: an approval for the first group of the current level the caller is eligible for. */
export function approveRequest(ctx: Ctx, id: string, b: ApproveBody): Promise<{ status: string }> {
  return inSpace(ctx, async (tx, spaceId) => {
    const { rq, decisions } = await locked(tx, spaceId, id);
    const why = await blockedFor(tx, ctx, rq, decisions);
    if (why) throw new ApiError(rq.requestedBy === ctx.user.id ? "self_approval" : rq.status !== "pending" ? "invalid_state" : "forbidden", why);
    const state = await levelState(tx, spaceId, rq, decisions, rq.currentLevel);
    const slot = state.find((s) => s.left > 0 && s.approvers.some((p) => p.id === ctx.user.id))!;
    await insertDecision(tx, rq, { level: rq.currentLevel, groupIndex: slot.gi, userId: ctx.user.id, decision: "approve", note: b.note });
    const levelDone = state.every((s) => (s === slot ? s.left - 1 : s.left) <= 0);
    const chain = rq.chain as Level[];
    const last = levelDone && rq.currentLevel + 1 >= chain.length;
    let after: Record<string, unknown> = { kind: rq.kind, level: rq.currentLevel + 1, of: chain.length, ...(b.note ? { note: b.note } : {}) };
    if (last) after = { ...after, final: true, ...(await finish(tx, ctx, rq, b.note ?? null)) };
    else if (levelDone) await tx.update(approvalRequests).set({ currentLevel: rq.currentLevel + 1 }).where(eq(approvalRequests.id, rq.id));
    // the recon version's actions on these events go to the outbox in this transaction (stage 4); nothing is sent here
    const events: ActionEvent[] = levelDone ? [{ event: "level_approved", level: rq.currentLevel + 1 }, ...(last ? [{ event: "approved" } as const] : [])] : [];
    await enqueueActions(tx, ctx, rq, events);
    await recordActivity(tx, ctx, { action: "break.approve", target: target(rq), before: { level: rq.currentLevel + 1 }, after });
    return { status: last ? "approved" : "pending" };
  });
}

/** POST …/approval-requests/{id}/reject: someone eligible at the current level ends it, with why; the subject goes back. */
export function rejectRequest(ctx: Ctx, id: string, b: RejectBody): Promise<{ status: string }> {
  return inSpace(ctx, async (tx, spaceId) => {
    const { rq, decisions } = await locked(tx, spaceId, id);
    const why = await blockedFor(tx, ctx, rq, decisions);
    if (why) throw new ApiError(rq.requestedBy === ctx.user.id ? "self_approval" : rq.status !== "pending" ? "invalid_state" : "forbidden", why);
    await insertDecision(tx, rq, { level: rq.currentLevel, groupIndex: null, userId: ctx.user.id, decision: "reject", note: b.note });
    await revertBreakRequest(tx, rq);
    await enqueueActions(tx, ctx, rq, [{ event: "rejected" }]);
    await tx.update(approvalRequests).set({ status: "rejected", decidedBy: ctx.user.id, decidedAt: sql`now()`, decisionNote: b.note }).where(eq(approvalRequests.id, rq.id));
    await recordActivity(tx, ctx, { action: "break.reject", target: target(rq), before: { level: rq.currentLevel + 1 }, after: { kind: rq.kind, note: b.note, requestedBy: rq.requestedBy } });
    return { status: "rejected" };
  });
}

/** POST …/approval-requests/{id}/override: a Superadmin approves what is left, with a reason; never their own request. */
export function overrideRequest(ctx: Ctx, id: string, b: OverrideBody): Promise<{ status: string }> {
  return inSpace(ctx, async (tx, spaceId) => {
    if (!isSuperadmin(ctx.user.roles)) throw new ApiError("forbidden", "Only a Superadmin overrides an approval chain.");
    const { rq, decisions } = await locked(tx, spaceId, id);
    if (rq.status !== "pending") throw new ApiError("invalid_state", `This request is ${rq.status}.`);
    if (rq.requestedBy === ctx.user.id) throw new ApiError("self_approval", "You asked for this. A Superadmin can't override their own request.");
    if (decisions.some((d) => d.userId === ctx.user.id)) throw new ApiError("invalid_state", "You decided this request already.");
    await insertDecision(tx, rq, { level: rq.currentLevel, groupIndex: null, userId: ctx.user.id, decision: "approve", note: b.reason, override: true });
    const done = await finish(tx, ctx, rq, b.reason);
    // the levels it skips fire in order (the bank's status update before the posting), then approved, all marked override
    const skipped: ActionEvent[] = Array.from({ length: Math.max(0, (rq.chain as Level[]).length - rq.currentLevel) }, (_, i) => ({ event: "level_approved", level: rq.currentLevel + 1 + i }));
    await enqueueActions(tx, ctx, rq, [...skipped, { event: "approved" }], true);
    await recordActivity(tx, ctx, { action: "break.override", target: target(rq), before: { level: rq.currentLevel + 1 }, after: { kind: rq.kind, reason: b.reason, ...done } });
    return { status: "approved" };
  });
}

/** POST …/approval-requests/{id}/cancel: the one who asked withdraws it while it waits; the subject goes back. */
export function cancelRequest(ctx: Ctx, id: string): Promise<{ status: string }> {
  return inSpace(ctx, async (tx, spaceId) => {
    const { rq } = await locked(tx, spaceId, id);
    if (rq.status !== "pending") throw new ApiError("invalid_state", `This request is ${rq.status}.`);
    if (rq.requestedBy !== ctx.user.id) throw new ApiError("forbidden", "Only whoever asked cancels a request.");
    await revertBreakRequest(tx, rq);
    await tx.update(approvalRequests).set({ status: "cancelled", decidedBy: ctx.user.id, decidedAt: sql`now()` }).where(eq(approvalRequests.id, rq.id));
    await recordActivity(tx, ctx, { action: "break.cancel", target: target(rq), before: { level: rq.currentLevel + 1 }, after: { kind: rq.kind } });
    return { status: "cancelled" };
  });
}
