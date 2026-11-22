// A space's approval rules (DEC-052 revision §4.3): per trigger, ordered rules that pick a library workflow, and the
// workflow for anything no rule matches (`otherwise`, null = the default chain). Versioned like a recon's config: a
// space admin of the space or a workflow.manage holder edits the draft (autosaved), sends it for approval, and another
// one of them publishes it (the workflow of workflows is fixed here: never routed through a workflow, so nobody locks
// the space out); the one before retires. A Superadmin publishes their own version only by override, with a reason.
// "Who approves" (preview) shows the rule and workflow sample attributes take and who could approve each group now.
import type {
  BindingSpec, PreviewDto, PreviewRulesBody, ReviewWorkflowBody, RulesDetailDto, RulesListDto, RulesVersionDto, SaveRulesBody,
} from "@starterkit/shared/contracts/workflows";
import { BindingSpec as SpecSchema } from "@starterkit/shared/contracts/workflows";
import { DEFAULT_CHAIN, pickBinding, TRIGGERS, type Trigger } from "@starterkit/shared/workflows";
import { and, desc, eq, inArray, max, sql } from "drizzle-orm";
import type { InTx } from "../../kernel/db";
import { ApiError, isUniqueViolation } from "../../kernel/errors";
import { recordActivity } from "../audit";
import type { Ctx } from "../auth";
import { withSpace } from "../spaces";
import { liveLibrary, liveVersion } from "./library";
import { approversOf } from "./requests";
import { approvalBindings, workflows } from "./schema";
import { reviewRule, userNames, type VersionRow, versionDto, versionPeople } from "./versions";

const inSpace = <T>(ctx: Ctx, fn: (tx: InTx, spaceId: string) => Promise<T>) =>
  withSpace({ spaceIds: [ctx.space!.id], userId: ctx.user.id }, (tx) => fn(tx, ctx.space!.id));
/** A space admin of this space, or a workflow.manage holder. */
export const canEdit = (ctx: Ctx) => ctx.perms.has("workflow.manage") || !!ctx.space?.roles.includes("space_admin");
const EDITORS = "a space admin or a workflow manager";
const EMPTY: BindingSpec = { rules: [], otherwise: null };
const target = (ctx: Ctx, trigger: Trigger) => ({ type: "approval_rules", id: `${ctx.space!.id}:${trigger}`, label: trigger });

async function versionsOf(tx: InTx, spaceId: string, trigger: Trigger) {
  const rows = await tx.select().from(approvalBindings).where(and(eq(approvalBindings.spaceId, spaceId), eq(approvalBindings.trigger, trigger), inArray(approvalBindings.status, ["draft", "in_review", "published"])));
  return { published: rows.find((r) => r.status === "published") ?? null, open: rows.find((r) => r.status === "draft" || r.status === "in_review") ?? null };
}
const workflowIdsOf = (s: BindingSpec) => [...new Set([...s.rules.map((r) => r.workflowId), ...(s.otherwise ? [s.otherwise] : [])])];

/** Every workflow the rules pick exists and has a live version, else 400 naming it. */
async function assertLive(tx: InTx, s: BindingSpec) {
  for (const id of workflowIdsOf(s)) {
    const [w] = await tx.select({ name: workflows.name, archivedAt: workflows.archivedAt }).from(workflows).where(eq(workflows.id, id));
    if (!w) throw new ApiError("bad_request", "A picked workflow no longer exists. Pick another one.");
    if (w.archivedAt || !(await liveVersion(tx, id))) throw new ApiError("bad_request", `“${w.name}” has no live version. Publish it in Workflows first, or pick another one.`);
  }
}

/** GET …/approval-rules: each trigger's live and open version. */
export function rulesList(ctx: Ctx): Promise<RulesListDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const items = [];
    for (const trigger of TRIGGERS) {
      const { published, open } = await versionsOf(tx, spaceId, trigger);
      const spec = published ? (published.spec as BindingSpec) : null;
      const otherwise = spec?.otherwise ? (await tx.select({ name: workflows.name }).from(workflows).where(eq(workflows.id, spec.otherwise)))[0]?.name ?? null : null;
      items.push({
        trigger,
        published: published ? { version: published.version, rules: spec!.rules.length, otherwise, decidedAt: published.decidedAt?.toISOString() ?? null } : null,
        open: open ? { version: open.version, status: open.status as "draft" | "in_review", updatedAt: open.updatedAt.toISOString() } : null,
      });
    }
    return { items };
  });
}

/** GET …/approval-rules/{trigger}, with the library the rules may pick from (a space admin needs no workflow.view for it). */
export function rulesDetail(ctx: Ctx, trigger: Trigger): Promise<RulesDetailDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const { published, open } = await versionsOf(tx, spaceId, trigger);
    const n = await userNames(tx, [...versionPeople(published), ...versionPeople(open)]);
    const { blocked, overrideOnly } = reviewRule(ctx, open as VersionRow | null, canEdit(ctx), EDITORS);
    return {
      trigger, library: (await liveLibrary(tx)).map(({ id, name, levels }) => ({ id, name, levels })),
      published: published ? versionDto<BindingSpec>(published, n) as RulesVersionDto : null, open: open ? versionDto<BindingSpec>(open, n) as RulesVersionDto : null,
      canEdit: canEdit(ctx), reviewBlocked: blocked, overrideOnly,
    };
  });
}

function mustEdit(ctx: Ctx) { if (!canEdit(ctx)) throw new ApiError("forbidden", "Only a space admin or a workflow manager edits approval rules."); }

/** POST …/approval-rules/{trigger}/draft: a new draft from the live version (or empty: the default chain), unless one is open. */
export function startDraft(ctx: Ctx, trigger: Trigger): Promise<RulesDetailDto> {
  mustEdit(ctx);
  return inSpace(ctx, async (tx, spaceId) => {
    const { published, open } = await versionsOf(tx, spaceId, trigger);
    if (open) throw new ApiError("invalid_state", open.status === "draft" ? "A draft of these rules is open already." : "A version of these rules waits for approval.");
    const [m] = await tx.select({ v: max(approvalBindings.version) }).from(approvalBindings).where(and(eq(approvalBindings.spaceId, spaceId), eq(approvalBindings.trigger, trigger)));
    const version = (m?.v ?? 0) + 1;
    try {
      await tx.insert(approvalBindings).values({ id: Bun.randomUUIDv7(), spaceId, trigger, version, status: "draft", spec: published?.spec ?? EMPTY, makerId: ctx.user.id });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError("invalid_state", "A draft of these rules is open already.");
      throw e;
    }
    await recordActivity(tx, ctx, { action: "rules.save", target: target(ctx, trigger), after: { version, from: published?.version ?? null } });
  }).then(() => rulesDetail(ctx, trigger));
}

/** The open draft, locked; 409 when none. */
async function draftOf(tx: InTx, spaceId: string, trigger: Trigger) {
  const [d] = await tx.select().from(approvalBindings).where(and(eq(approvalBindings.spaceId, spaceId), eq(approvalBindings.trigger, trigger), inArray(approvalBindings.status, ["draft", "in_review"]))).for("update");
  if (!d) throw new ApiError("invalid_state", "These rules have no open draft. Start one first.");
  return d;
}

/** PATCH …/approval-rules/{trigger}/draft (autosave); no entry when nothing changed. */
export function saveDraft(ctx: Ctx, trigger: Trigger, b: SaveRulesBody): Promise<RulesDetailDto> {
  mustEdit(ctx);
  return inSpace(ctx, async (tx, spaceId) => {
    const d = await draftOf(tx, spaceId, trigger);
    if (d.status !== "draft") throw new ApiError("invalid_state", "This version waits for approval and can't change. Ask for it back to edit it.");
    if (JSON.stringify(d.spec) === JSON.stringify(b.spec)) return;
    await assertLive(tx, b.spec);
    await tx.update(approvalBindings).set({ spec: b.spec, updatedAt: sql`now()`, reviewComment: null }).where(eq(approvalBindings.id, d.id));
    await recordActivity(tx, ctx, { action: "rules.save", target: target(ctx, trigger), after: { version: d.version, rules: b.spec.rules.length } });
  }).then(() => rulesDetail(ctx, trigger));
}

/** POST …/approval-rules/{trigger}/draft/submit. */
export function submitDraft(ctx: Ctx, trigger: Trigger): Promise<RulesDetailDto> {
  mustEdit(ctx);
  return inSpace(ctx, async (tx, spaceId) => {
    const d = await draftOf(tx, spaceId, trigger);
    if (d.status !== "draft") throw new ApiError("invalid_state", "This version waits for approval already.");
    await assertLive(tx, SpecSchema.parse(d.spec));
    await tx.update(approvalBindings).set({ status: "in_review", submittedBy: ctx.user.id, submittedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(approvalBindings.id, d.id));
    await recordActivity(tx, ctx, { action: "rules.submit", target: target(ctx, trigger), after: { version: d.version } });
  }).then(() => rulesDetail(ctx, trigger));
}

/** POST …/approval-rules/{trigger}/draft/discard: the draft goes; the live version stays. */
export function discardDraft(ctx: Ctx, trigger: Trigger): Promise<RulesDetailDto> {
  mustEdit(ctx);
  return inSpace(ctx, async (tx, spaceId) => {
    const d = await draftOf(tx, spaceId, trigger);
    if (d.status !== "draft") throw new ApiError("invalid_state", "This version waits for approval. Send it back to discard it.");
    await tx.delete(approvalBindings).where(eq(approvalBindings.id, d.id));
    await recordActivity(tx, ctx, { action: "rules.discard", target: target(ctx, trigger), before: { version: d.version } });
  }).then(() => rulesDetail(ctx, trigger));
}

/** POST …/approval-rules/{trigger}/review/approve|reject. */
export function reviewDraft(ctx: Ctx, trigger: Trigger, b: ReviewWorkflowBody, how: "approve" | "reject"): Promise<RulesDetailDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const d = await draftOf(tx, spaceId, trigger);
    const { blocked, overrideOnly } = reviewRule(ctx, d as VersionRow, canEdit(ctx), EDITORS);
    if (blocked) throw new ApiError(d.makerId === ctx.user.id || d.submittedBy === ctx.user.id ? "self_approval" : d.status !== "in_review" ? "invalid_state" : "forbidden", blocked);
    const comment = b.comment?.trim() || null;
    if (overrideOnly && (!b.override || !comment)) throw new ApiError("self_approval", "You made this version. A Superadmin publishes their own version only by override, with a reason.");
    if (how === "reject") {
      if (!comment) throw new ApiError("bad_request", "Say why it goes back.");
      await tx.update(approvalBindings).set({ status: "draft", reviewComment: comment, decidedBy: ctx.user.id, decidedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(approvalBindings.id, d.id));
      await recordActivity(tx, ctx, { action: "rules.reject", target: target(ctx, trigger), after: { version: d.version, comment } });
      return;
    }
    await assertLive(tx, d.spec as BindingSpec);
    await tx.update(approvalBindings).set({ status: "retired", updatedAt: sql`now()` })
      .where(and(eq(approvalBindings.spaceId, spaceId), eq(approvalBindings.trigger, trigger), eq(approvalBindings.status, "published")));
    await tx.update(approvalBindings).set({
      status: "published", decidedBy: ctx.user.id, decidedAt: sql`now()`, reviewComment: overrideOnly ? null : comment, overrideReason: overrideOnly ? comment : null, updatedAt: sql`now()`,
    }).where(eq(approvalBindings.id, d.id));
    await recordActivity(tx, ctx, { action: "rules.publish", target: target(ctx, trigger), after: { version: d.version, ...(overrideOnly ? { override: comment } : comment ? { comment } : {}) } });
  }).then(() => rulesDetail(ctx, trigger));
}

/** POST …/approval-rules/{trigger}/preview: the rule and workflow sample attributes take (the draft's rules, else the live ones) and who approves it now. */
export function previewRules(ctx: Ctx, trigger: Trigger, b: PreviewRulesBody): Promise<PreviewDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    let spec = b.spec ?? null;
    if (!spec) {
      const [p] = await tx.select({ spec: approvalBindings.spec }).from(approvalBindings)
        .where(and(eq(approvalBindings.spaceId, spaceId), eq(approvalBindings.trigger, trigger), eq(approvalBindings.status, "published"))).orderBy(desc(approvalBindings.version)).limit(1);
      spec = (p?.spec as BindingSpec | undefined) ?? null;
    }
    const pick = pickBinding(spec, b.attributes);
    const live = pick.workflowId ? await liveVersion(tx, pick.workflowId) : null;
    const chain = live?.spec ?? DEFAULT_CHAIN;
    const none = new Set<string>();
    const levels = [];
    for (const lv of chain.levels) {
      const groups = [];
      for (const g of lv.groups) {
        const approvers = await approversOf(tx, spaceId, g, none);
        const want = g.need.kind === "count" ? g.need.n : 1;
        groups.push({ need: g.need.kind === "count" ? { kind: "count" as const, n: g.need.n } : { kind: g.need.kind }, approvers, short: approvers.length < want });
      }
      levels.push({ name: lv.name, groups });
    }
    return { rule: { name: pick.ruleName, index: pick.index }, workflow: live && pick.workflowId ? { id: pick.workflowId, name: chain.name } : null, levels };
  });
}
