// A space's approval workflows (DEC-052): one per action, versioned like a recon's config. A space admin of the space
// or a workflow.manage holder edits the draft (autosaved), sends it for approval, and another one of them publishes it
// (the workflow of workflows is fixed here, §4.6 of the design: never routed through a workflow, so nobody locks the
// space out); the one before retires. A Superadmin publishes their own version only by override, with a reason.
// "Who approves" (preview) shows the chain sample attributes would take and who could approve each group now.
import type {
  PreviewDto, PreviewWorkflowBody, ReviewWorkflowBody, SaveWorkflowBody, WorkflowDetailDto, WorkflowListDto, WorkflowSpec, WorkflowVersionDto,
} from "@starterkit/shared/contracts/workflows";
import { WorkflowSpec as SpecSchema } from "@starterkit/shared/contracts/workflows";
import { isSuperadmin } from "@starterkit/shared/permissions";
import { pickRule, WORKFLOW_ACTIONS, type WorkflowAction } from "@starterkit/shared/workflows";
import { and, desc, eq, inArray, max, sql } from "drizzle-orm";
import type { InTx } from "../../kernel/db";
import { ApiError, isUniqueViolation } from "../../kernel/errors";
import { recordActivity } from "../audit";
import type { Ctx } from "../auth";
import { roles } from "../rbac";
import { withSpace } from "../spaces";
import { users } from "../users";
import { approversOf } from "./requests";
import { approvalWorkflows } from "./schema";

type Row = typeof approvalWorkflows.$inferSelect;
const inSpace = <T>(ctx: Ctx, fn: (tx: InTx, spaceId: string) => Promise<T>) =>
  withSpace({ spaceIds: [ctx.space!.id], userId: ctx.user.id }, (tx) => fn(tx, ctx.space!.id));
/** A space admin of this space, or a workflow.manage holder. */
export const canEdit = (ctx: Ctx) => ctx.perms.has("workflow.manage") || !!ctx.space?.roles.includes("space_admin");
const EMPTY: WorkflowSpec = { rules: [] };
const target = (ctx: Ctx, action: WorkflowAction) => ({ type: "workflow", id: `${ctx.space!.id}:${action}`, label: action });

async function versionsOf(tx: InTx, spaceId: string, action: WorkflowAction) {
  const rows = await tx.select().from(approvalWorkflows).where(and(eq(approvalWorkflows.spaceId, spaceId), eq(approvalWorkflows.action, action), inArray(approvalWorkflows.status, ["draft", "in_review", "published"])));
  return { published: rows.find((r) => r.status === "published") ?? null, open: rows.find((r) => r.status === "draft" || r.status === "in_review") ?? null };
}
async function names(tx: InTx, ids: readonly (string | null)[]) {
  const uniq = [...new Set(ids.filter((x): x is string => !!x))];
  return new Map(uniq.length ? (await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, uniq))).map((u) => [u.id, u.name]) : []);
}
function dto(r: Row, n: Map<string, string | null>): WorkflowVersionDto {
  const p = (id: string | null) => (id ? { id, name: n.get(id) ?? null } : null);
  return {
    id: r.id, version: r.version, status: r.status as WorkflowVersionDto["status"], spec: r.spec as WorkflowSpec,
    maker: p(r.makerId), submittedBy: p(r.submittedBy), submittedAt: r.submittedAt?.toISOString() ?? null, decidedBy: p(r.decidedBy), decidedAt: r.decidedAt?.toISOString() ?? null,
    reviewComment: r.reviewComment, overrideReason: r.overrideReason, updatedAt: r.updatedAt.toISOString(),
  };
}
/** Why the caller can't publish or send back the version in review, or null; `override`: only by a reason (own version, Superadmin). */
function reviewRule(ctx: Ctx, open: Row | null): { blocked: string | null; overrideOnly: boolean } {
  if (!open || open.status !== "in_review") return { blocked: "No version waits for approval.", overrideOnly: false };
  if (!canEdit(ctx)) return { blocked: "Only a space admin or a workflow manager decides workflow changes.", overrideOnly: false };
  const own = open.makerId === ctx.user.id || open.submittedBy === ctx.user.id;
  if (own && isSuperadmin(ctx.user.roles)) return { blocked: null, overrideOnly: true };
  if (own) return { blocked: "You made this version. Another space admin or workflow manager decides it.", overrideOnly: false };
  return { blocked: null, overrideOnly: false };
}

/** GET …/workflows: each action's live and open version. */
export function workflowList(ctx: Ctx): Promise<WorkflowListDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const items = [];
    for (const action of WORKFLOW_ACTIONS) {
      const { published, open } = await versionsOf(tx, spaceId, action);
      const spec = published ? (published.spec as WorkflowSpec) : null;
      items.push({
        action,
        published: published ? { version: published.version, rules: spec!.rules.length, levels: Math.max(0, ...spec!.rules.map((r) => r.levels.length)), decidedAt: published.decidedAt?.toISOString() ?? null } : null,
        open: open ? { version: open.version, status: open.status as "draft" | "in_review", updatedAt: open.updatedAt.toISOString() } : null,
      });
    }
    return { items };
  });
}

/** GET …/workflows/{action}. */
export function workflowDetail(ctx: Ctx, action: WorkflowAction): Promise<WorkflowDetailDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const { published, open } = await versionsOf(tx, spaceId, action);
    const specs = [published, open].filter((r): r is Row => !!r).map((r) => r.spec as WorkflowSpec);
    const named = specs.flatMap((s) => s.rules.flatMap((r) => r.levels.flatMap((l) => l.groups.flatMap((g) => g.users))));
    const n = await names(tx, [...named, ...[published, open].flatMap((r) => (r ? [r.makerId, r.submittedBy, r.decidedBy] : []))]);
    const globalRoles = (await tx.select({ name: roles.name }).from(roles).orderBy(sql`lower(${roles.name})`)).map((r) => r.name);
    const { blocked, overrideOnly } = reviewRule(ctx, open);
    return {
      action, published: published ? dto(published, n) : null, open: open ? dto(open, n) : null, globalRoles,
      people: [...new Set(named)].map((id) => ({ id, name: n.get(id) ?? null })), canEdit: canEdit(ctx), reviewBlocked: blocked, overrideOnly,
    };
  });
}

function mustEdit(ctx: Ctx) { if (!canEdit(ctx)) throw new ApiError("forbidden", "Only a space admin or a workflow manager edits approval workflows."); }

/** POST …/workflows/{action}/draft: a new draft from the live version (or empty: the default chain), unless one is open. */
export function startDraft(ctx: Ctx, action: WorkflowAction): Promise<WorkflowDetailDto> {
  mustEdit(ctx);
  return inSpace(ctx, async (tx, spaceId) => {
    const { published, open } = await versionsOf(tx, spaceId, action);
    if (open) throw new ApiError("invalid_state", open.status === "draft" ? "A draft of this workflow is open already." : "A version of this workflow waits for approval.");
    const [m] = await tx.select({ v: max(approvalWorkflows.version) }).from(approvalWorkflows).where(and(eq(approvalWorkflows.spaceId, spaceId), eq(approvalWorkflows.action, action)));
    const version = (m?.v ?? 0) + 1;
    try {
      await tx.insert(approvalWorkflows).values({ id: Bun.randomUUIDv7(), spaceId, action, version, status: "draft", spec: published?.spec ?? EMPTY, makerId: ctx.user.id });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError("invalid_state", "A draft of this workflow is open already.");
      throw e;
    }
    await recordActivity(tx, ctx, { action: "workflow.save", target: target(ctx, action), after: { version, from: published?.version ?? null } });
  }).then(() => workflowDetail(ctx, action));
}

/** The open draft, locked; 409 when none (or it waits for approval). */
async function draftOf(tx: InTx, spaceId: string, action: WorkflowAction) {
  const [d] = await tx.select().from(approvalWorkflows).where(and(eq(approvalWorkflows.spaceId, spaceId), eq(approvalWorkflows.action, action), inArray(approvalWorkflows.status, ["draft", "in_review"]))).for("update");
  if (!d) throw new ApiError("invalid_state", "This workflow has no open draft. Start one first.");
  return d;
}

/** PATCH …/workflows/{action}/draft: the rules (autosave); no entry when nothing changed. */
export function saveDraft(ctx: Ctx, action: WorkflowAction, b: SaveWorkflowBody): Promise<WorkflowDetailDto> {
  mustEdit(ctx);
  return inSpace(ctx, async (tx, spaceId) => {
    const d = await draftOf(tx, spaceId, action);
    if (d.status !== "draft") throw new ApiError("invalid_state", "This version waits for approval and can't change. Ask for it back to edit it.");
    if (JSON.stringify(d.spec) === JSON.stringify(b.spec)) return;
    await tx.update(approvalWorkflows).set({ spec: b.spec, updatedAt: sql`now()`, reviewComment: null }).where(eq(approvalWorkflows.id, d.id));
    await recordActivity(tx, ctx, { action: "workflow.save", target: target(ctx, action), after: { version: d.version, rules: b.spec.rules.length } });
  }).then(() => workflowDetail(ctx, action));
}

/** POST …/workflows/{action}/draft/submit. */
export function submitDraft(ctx: Ctx, action: WorkflowAction): Promise<WorkflowDetailDto> {
  mustEdit(ctx);
  return inSpace(ctx, async (tx, spaceId) => {
    const d = await draftOf(tx, spaceId, action);
    if (d.status !== "draft") throw new ApiError("invalid_state", "This version waits for approval already.");
    SpecSchema.parse(d.spec);
    await tx.update(approvalWorkflows).set({ status: "in_review", submittedBy: ctx.user.id, submittedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(approvalWorkflows.id, d.id));
    await recordActivity(tx, ctx, { action: "workflow.submit", target: target(ctx, action), after: { version: d.version } });
  }).then(() => workflowDetail(ctx, action));
}

/** POST …/workflows/{action}/draft/discard: the draft goes; the live version stays. */
export function discardDraft(ctx: Ctx, action: WorkflowAction): Promise<WorkflowDetailDto> {
  mustEdit(ctx);
  return inSpace(ctx, async (tx, spaceId) => {
    const d = await draftOf(tx, spaceId, action);
    if (d.status !== "draft") throw new ApiError("invalid_state", "This version waits for approval. Send it back to discard it.");
    await tx.delete(approvalWorkflows).where(eq(approvalWorkflows.id, d.id));
    await recordActivity(tx, ctx, { action: "workflow.discard", target: target(ctx, action), before: { version: d.version } });
  }).then(() => workflowDetail(ctx, action));
}

/** POST …/workflows/{action}/review/approve|reject. */
export function reviewDraft(ctx: Ctx, action: WorkflowAction, b: ReviewWorkflowBody, how: "approve" | "reject"): Promise<WorkflowDetailDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const d = await draftOf(tx, spaceId, action);
    const { blocked, overrideOnly } = reviewRule(ctx, d);
    if (blocked) throw new ApiError(d.makerId === ctx.user.id || d.submittedBy === ctx.user.id ? "self_approval" : d.status !== "in_review" ? "invalid_state" : "forbidden", blocked);
    const comment = b.comment?.trim() || null;
    if (overrideOnly && (!b.override || !comment)) throw new ApiError("self_approval", "You made this version. A Superadmin publishes their own version only by override, with a reason.");
    if (how === "reject") {
      if (!comment) throw new ApiError("bad_request", "Say why it goes back.");
      await tx.update(approvalWorkflows).set({ status: "draft", reviewComment: comment, decidedBy: ctx.user.id, decidedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(approvalWorkflows.id, d.id));
      await recordActivity(tx, ctx, { action: "workflow.reject", target: target(ctx, action), after: { version: d.version, comment } });
      return;
    }
    await tx.update(approvalWorkflows).set({ status: "retired", updatedAt: sql`now()` })
      .where(and(eq(approvalWorkflows.spaceId, spaceId), eq(approvalWorkflows.action, action), eq(approvalWorkflows.status, "published")));
    await tx.update(approvalWorkflows).set({
      status: "published", decidedBy: ctx.user.id, decidedAt: sql`now()`, reviewComment: overrideOnly ? null : comment, overrideReason: overrideOnly ? comment : null, updatedAt: sql`now()`,
    }).where(eq(approvalWorkflows.id, d.id));
    await recordActivity(tx, ctx, { action: "workflow.publish", target: target(ctx, action), after: { version: d.version, ...(overrideOnly ? { override: comment } : comment ? { comment } : {}) } });
  }).then(() => workflowDetail(ctx, action));
}

/** POST …/workflows/{action}/preview: the chain sample attributes take (the draft's rules, else the live ones) and who approves it now. */
export function previewWorkflow(ctx: Ctx, action: WorkflowAction, b: PreviewWorkflowBody): Promise<PreviewDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    let spec = b.spec ?? null;
    if (!spec) {
      const [p] = await tx.select({ spec: approvalWorkflows.spec }).from(approvalWorkflows)
        .where(and(eq(approvalWorkflows.spaceId, spaceId), eq(approvalWorkflows.action, action), eq(approvalWorkflows.status, "published"))).orderBy(desc(approvalWorkflows.version)).limit(1);
      spec = (p?.spec as WorkflowSpec | undefined) ?? null;
    }
    const { rule, index } = pickRule(spec, b.attributes);
    const none = new Set<string>();
    const levels = [];
    for (const lv of rule.levels) {
      const groups = [];
      for (const g of lv.groups) {
        const approvers = await approversOf(tx, spaceId, g, none);
        // the one who asks never approves: a group of only them, or fewer than it needs, is short
        const want = g.need.kind === "count" ? g.need.n : 1;
        groups.push({ need: g.need.kind === "count" ? { kind: "count" as const, n: g.need.n } : { kind: g.need.kind }, approvers, short: approvers.length < want });
      }
      levels.push({ name: lv.name, groups });
    }
    return { rule: { name: rule.name, index }, levels };
  });
}
