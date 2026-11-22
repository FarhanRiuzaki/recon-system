// A space's workflows (DEC-052 rev 2, design §4.1): named chains of levels, versioned, owned by the space (row level
// security). A space admin of the space or a workflow.manage holder edits; another one of them publishes (a Superadmin
// their own only by override, with a reason); only a draft's maker saves it. Recon versions of the space pin a version
// of a workflow for a change ("Used by"); archiving one they pin is refused.
import type { Page } from "@starterkit/shared/contracts/common";
import type {
  ChainSpec, ChainVersionDto, CreateWorkflowBody, LibraryDetailDto, LibraryRowDto, ReviewWorkflowBody, SaveChainBody, UsedByQuery, UsedByRowDto, WorkflowListQuery,
} from "@starterkit/shared/contracts/workflows";
import { ChainSpec as ChainSchema } from "@starterkit/shared/contracts/workflows";
import type { ReconApprovalSpec } from "@starterkit/shared/contracts/recon";
import { groupNeeds, type Level, TRIGGER_LABEL, type Trigger, TRIGGERS } from "@starterkit/shared/workflows";
import { and, eq, ilike, inArray, isNull, max, sql } from "drizzle-orm";
import type { InTx } from "../../kernel/db";
import { ApiError, isUniqueViolation, notFound } from "../../kernel/errors";
import { likeEscape, pageQuery, sortSql } from "../../kernel/pagination";
import { recordActivity } from "../audit";
import type { Ctx } from "../auth";
import { roles } from "../rbac";
import { reconConfigs, reconConfigVersions } from "../recon";
import { withSpace } from "../spaces";
import { approversOf } from "./requests";
import { workflows, workflowVersions } from "./schema";
import { reviewRule, userNames, type VersionRow, versionDto, versionPeople } from "./versions";

type Row = typeof workflowVersions.$inferSelect;
const EDITORS = "a space admin or a workflow manager";
/** A space admin of this space, or a workflow.manage holder. */
export const canEdit = (ctx: Ctx) => ctx.perms.has("workflow.manage") || !!ctx.space?.roles.includes("space_admin");
const mustEdit = (ctx: Ctx) => { if (!canEdit(ctx)) throw new ApiError("forbidden", "Only a space admin or a workflow manager edits workflows."); };
const target = (id: string, name: string) => ({ type: "workflow", id, label: name });
const DUPLICATE = "A workflow with this name exists in this space. Pick another name.";
const inSpace = <T>(ctx: Ctx, fn: (tx: InTx, spaceId: string) => Promise<T>) =>
  withSpace({ spaceIds: [ctx.space!.id], userId: ctx.user.id }, (tx) => fn(tx, ctx.space!.id));

async function versionsOf(tx: InTx, workflowId: string) {
  const rows = await tx.select().from(workflowVersions).where(and(eq(workflowVersions.workflowId, workflowId), inArray(workflowVersions.status, ["draft", "in_review", "published"])));
  return { published: rows.find((r) => r.status === "published") ?? null, open: rows.find((r) => r.status === "draft" || r.status === "in_review") ?? null };
}
/** The space's workflow `id`; another space's is 404 (by the filter, and by row level security for the app role). */
async function workflowOf(tx: InTx, spaceId: string, id: string, lock = false) {
  const q = tx.select().from(workflows).where(and(eq(workflows.spaceId, spaceId), eq(workflows.id, id)));
  const [w] = lock ? await q.for("update") : await q;
  if (!w) throw notFound("workflow");
  return w;
}

/** A level in words for a warning: "Level 2 (Treasury head)". */
export const levelLabel = (l: Level, i: number) => `Level ${i + 1}${l.name ? ` (${l.name})` : ""}`;
/** The levels of `levels` that would lack people in `spaceId` (approvers must be active members of the space). */
export async function shortLevels(tx: InTx, spaceId: string, levels: readonly Level[]): Promise<string[]> {
  const out: string[] = [];
  const none = new Set<string>();
  for (const [i, l] of levels.entries()) {
    for (const g of l.groups) {
      if (groupNeeds(g.need, (await approversOf(tx, spaceId, g, none)).length, 0).short) { out.push(levelLabel(l, i)); break; }
    }
  }
  return out;
}

/** Recon versions (live or open) of the space whose approval setup names workflow `id`. */
const pinsWhere = (spaceId: string, id: string) => and(
  eq(reconConfigVersions.spaceId, spaceId),
  inArray(reconConfigVersions.status, ["draft", "in_review", "published"]),
  sql`jsonb_path_exists(${reconConfigVersions.spec}, '$.approvals.changes.*.workflow.** ? (@.id == $id)', jsonb_build_object('id', ${id}::text))`,
);
/** Per change, the rules ("Default" for the default) of `spec` that pin `id`, and the version they pin. */
export function pinsOf(spec: { approvals?: ReconApprovalSpec }, id: string): { change: Trigger; rules: string[]; pinned: number }[] {
  const out = [];
  for (const change of TRIGGERS) {
    const w = spec.approvals?.changes[change]?.workflow;
    if (!w) continue;
    const hits = [...(w.default?.id === id ? [{ name: "Default", v: w.default.version }] : []), ...w.rules.filter((r) => r.workflow.id === id).map((r) => ({ name: r.name, v: r.workflow.version }))];
    if (hits.length) out.push({ change, rules: hits.map((h) => h.name), pinned: Math.min(...hits.map((h) => h.v)) });
  }
  return out;
}

/** GET …/workflows: the space's workflows, by name; each with its live and open version and how many live recons use it. */
export function workflowPage(ctx: Ctx, q: WorkflowListQuery): Promise<Page<LibraryRowDto>> {
  return inSpace(ctx, async (tx, spaceId) => {
    const where = and(eq(workflows.spaceId, spaceId), q.q ? ilike(workflows.name, `%${likeEscape(q.q)}%`) : undefined);
    const page = await pageQuery({
      rows: tx.select().from(workflows).where(where).$dynamic(), count: tx.select({ id: workflows.id }).from(workflows).where(where).$dynamic(),
      orderBy: sortSql(q.sort, { name: sql`lower(${workflows.name})`, createdAt: workflows.createdAt }, "name", workflows.id), query: q, map: (w) => w, on: tx,
    });
    const ids = page.items.map((w) => w.id);
    const versions = ids.length ? await tx.select().from(workflowVersions).where(and(inArray(workflowVersions.workflowId, ids), inArray(workflowVersions.status, ["draft", "in_review", "published"]))) : [];
    const items: LibraryRowDto[] = [];
    for (const w of page.items) {
      const pub = versions.find((v) => v.workflowId === w.id && v.status === "published");
      const open = versions.find((v) => v.workflowId === w.id && v.status !== "published");
      const spec = (pub ?? open)?.spec as ChainSpec | undefined;
      const [{ n } = { n: 0 }] = await tx.select({ n: sql<number>`count(distinct ${reconConfigVersions.configId})::int` }).from(reconConfigVersions)
        .where(and(pinsWhere(spaceId, w.id), eq(reconConfigVersions.status, "published")));
      items.push({
        id: w.id, name: w.name, levels: spec?.levels.length ?? 0, archived: !!w.archivedAt,
        published: pub ? { version: pub.version, decidedAt: pub.decidedAt?.toISOString() ?? null } : null,
        open: open ? { version: open.version, status: open.status as "draft" | "in_review", updatedAt: open.updatedAt.toISOString() } : null,
        reconsUsing: n, updatedAt: ((open ?? pub)?.updatedAt ?? w.createdAt).toISOString(),
      });
    }
    return { ...page, items };
  });
}

/** GET …/workflows/{id}. */
export function workflowDetail(ctx: Ctx, id: string): Promise<LibraryDetailDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const w = await workflowOf(tx, spaceId, id);
    const { published, open } = await versionsOf(tx, id);
    const named = [published, open].flatMap((r) => (r ? (r.spec as ChainSpec).levels.flatMap((l) => l.groups.flatMap((g) => g.users)) : []));
    const n = await userNames(tx, [...named, ...versionPeople(published), ...versionPeople(open)]);
    const globalRoles = (await tx.select({ name: roles.name }).from(roles).orderBy(sql`lower(${roles.name})`)).map((r) => r.name);
    const { blocked, overrideOnly } = reviewRule(ctx, open as VersionRow | null, canEdit(ctx), EDITORS);
    return {
      id: w.id, name: w.name, archived: !!w.archivedAt, globalRoles,
      published: published ? versionDto<ChainSpec>(published, n) as ChainVersionDto : null, open: open ? versionDto<ChainSpec>(open, n) as ChainVersionDto : null,
      people: [...new Set(named)].map((u) => ({ id: u, name: n.get(u) ?? null })), canEdit: canEdit(ctx), reviewBlocked: blocked, overrideOnly,
    };
  });
}

/** GET …/workflows/{id}/used-by: the recon versions (live or open) of the space that pin it, with the version they pin. */
export function usedBy(ctx: Ctx, id: string, q: UsedByQuery): Promise<Page<UsedByRowDto>> {
  return inSpace(ctx, async (tx, spaceId) => {
    await workflowOf(tx, spaceId, id);
    const { published } = await versionsOf(tx, id);
    const where = pinsWhere(spaceId, id);
    const page = await pageQuery({
      rows: tx.select({ v: reconConfigVersions, name: reconConfigs.name }).from(reconConfigVersions).innerJoin(reconConfigs, eq(reconConfigs.id, reconConfigVersions.configId)).where(where).$dynamic(),
      count: tx.select({ id: reconConfigVersions.id }).from(reconConfigVersions).where(where).$dynamic(),
      orderBy: [sql`lower(${reconConfigs.name})`, sql`${reconConfigVersions.version}`, sql`${reconConfigVersions.id}`], query: q, map: (r) => r, on: tx,
    });
    const items = page.items.flatMap(({ v, name }) => pinsOf(v.spec as { approvals?: ReconApprovalSpec }, id).map((p) => ({
      reconId: v.configId, reconName: name, change: p.change, rules: p.rules, reconVersion: v.version, reconStatus: v.status as UsedByRowDto["reconStatus"],
      pinned: p.pinned, outdated: !!published && p.pinned < published.version,
    })));
    return { ...page, items };
  });
}

const named = async <T>(p: Promise<T>): Promise<T> => p.catch((e) => { throw isUniqueViolation(e) ? new ApiError("duplicate", DUPLICATE) : e; });

/** POST …/workflows: a new workflow of the space and its first draft. */
export async function createWorkflow(ctx: Ctx, b: CreateWorkflowBody): Promise<LibraryDetailDto> {
  mustEdit(ctx);
  const id = Bun.randomUUIDv7();
  await named(inSpace(ctx, async (tx, spaceId) => {
    await tx.insert(workflows).values({ id, spaceId, name: b.spec.name });
    await tx.insert(workflowVersions).values({ id: Bun.randomUUIDv7(), spaceId, workflowId: id, version: 1, status: "draft", spec: b.spec, makerId: ctx.user.id });
    await recordActivity(tx, ctx, { action: "workflow.create", target: target(id, b.spec.name), after: { name: b.spec.name, levels: b.spec.levels.length } });
  }));
  return workflowDetail(ctx, id);
}

/** POST …/workflows/{id}/draft: a new draft from the live version, unless one is open. */
export async function startWorkflowDraft(ctx: Ctx, id: string): Promise<LibraryDetailDto> {
  mustEdit(ctx);
  await inSpace(ctx, async (tx, spaceId) => {
    const w = await workflowOf(tx, spaceId, id, true);
    if (w.archivedAt) throw new ApiError("invalid_state", "This workflow is archived.");
    const { published, open } = await versionsOf(tx, id);
    if (open) throw new ApiError("invalid_state", open.status === "draft" ? "A draft of this workflow is open already." : "A version of this workflow waits for approval.");
    const [m] = await tx.select({ v: max(workflowVersions.version) }).from(workflowVersions).where(eq(workflowVersions.workflowId, id));
    const version = (m?.v ?? 0) + 1;
    try {
      await tx.insert(workflowVersions).values({ id: Bun.randomUUIDv7(), spaceId, workflowId: id, version, status: "draft", spec: published!.spec, makerId: ctx.user.id });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError("invalid_state", "A draft of this workflow is open already.");
      throw e;
    }
    await recordActivity(tx, ctx, { action: "workflow.save", target: target(id, w.name), after: { version, from: published?.version ?? null } });
  });
  return workflowDetail(ctx, id);
}

/** The open version, locked; 409 when none. */
async function draftOf(tx: InTx, id: string): Promise<Row> {
  const [d] = await tx.select().from(workflowVersions).where(and(eq(workflowVersions.workflowId, id), inArray(workflowVersions.status, ["draft", "in_review"]))).for("update");
  if (!d) throw new ApiError("invalid_state", "This workflow has no open draft. Start one first.");
  return d;
}
/**
 * Only the draft's maker edits it: maker-checker counts the maker (and who sent it) as its authors, so a second editor's
 * changes would let them publish what they wrote, and their autosaves would overwrite each other.
 */
export async function assertMaker(tx: InTx, ctx: Ctx, d: { makerId: string | null }) {
  if (!d.makerId || d.makerId === ctx.user.id) return;
  const who = (await userNames(tx, [d.makerId])).get(d.makerId) ?? "someone else";
  throw new ApiError("invalid_state", `This draft is ${who}'s. Ask them to send it for approval or discard it, then start your own.`);
}
const hasPublished = async (tx: InTx, id: string) => (await tx.select({ id: workflowVersions.id }).from(workflowVersions).where(and(eq(workflowVersions.workflowId, id), eq(workflowVersions.status, "published")))).length > 0;

/** PATCH …/workflows/{id}/draft (autosave); no entry when nothing changed. A never-published workflow takes the draft's name. */
export async function saveWorkflowDraft(ctx: Ctx, id: string, b: SaveChainBody): Promise<LibraryDetailDto> {
  mustEdit(ctx);
  await named(inSpace(ctx, async (tx, spaceId) => {
    const w = await workflowOf(tx, spaceId, id, true);
    const d = await draftOf(tx, id);
    if (d.status !== "draft") throw new ApiError("invalid_state", "This version waits for approval and can't change. Ask for it back to edit it.");
    await assertMaker(tx, ctx, d);
    if (JSON.stringify(d.spec) === JSON.stringify(b.spec)) return;
    await tx.update(workflowVersions).set({ spec: b.spec, updatedAt: sql`now()`, reviewComment: null }).where(eq(workflowVersions.id, d.id));
    if (!(await hasPublished(tx, id)) && w.name !== b.spec.name) await tx.update(workflows).set({ name: b.spec.name }).where(eq(workflows.id, id));
    await recordActivity(tx, ctx, { action: "workflow.save", target: target(id, b.spec.name), after: { version: d.version, levels: b.spec.levels.length } });
  }));
  return workflowDetail(ctx, id);
}

/** POST …/workflows/{id}/draft/submit. */
export async function submitWorkflowDraft(ctx: Ctx, id: string): Promise<LibraryDetailDto> {
  mustEdit(ctx);
  await inSpace(ctx, async (tx, spaceId) => {
    const w = await workflowOf(tx, spaceId, id, true);
    const d = await draftOf(tx, id);
    if (d.status !== "draft") throw new ApiError("invalid_state", "This version waits for approval already.");
    ChainSchema.parse(d.spec);
    await tx.update(workflowVersions).set({ status: "in_review", submittedBy: ctx.user.id, submittedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(workflowVersions.id, d.id));
    await recordActivity(tx, ctx, { action: "workflow.submit", target: target(id, w.name), after: { version: d.version } });
  });
  return workflowDetail(ctx, id);
}

/** POST …/workflows/{id}/draft/discard: the draft goes; a workflow never published goes with it. Answers null then. */
export async function discardWorkflowDraft(ctx: Ctx, id: string): Promise<LibraryDetailDto | null> {
  mustEdit(ctx);
  const gone = await inSpace(ctx, async (tx, spaceId) => {
    const w = await workflowOf(tx, spaceId, id, true);
    const d = await draftOf(tx, id);
    if (d.status !== "draft") throw new ApiError("invalid_state", "This version waits for approval. Send it back to discard it.");
    await tx.delete(workflowVersions).where(eq(workflowVersions.id, d.id));
    const last = !(await hasPublished(tx, id));
    if (last) await tx.delete(workflows).where(eq(workflows.id, id));
    await recordActivity(tx, ctx, { action: "workflow.discard", target: target(id, w.name), before: { version: d.version } });
    return last;
  });
  return gone ? null : workflowDetail(ctx, id);
}

/** POST …/workflows/{id}/review/approve|reject. Publishing names the workflow after its new version. */
export async function reviewWorkflowDraft(ctx: Ctx, id: string, b: ReviewWorkflowBody, how: "approve" | "reject"): Promise<LibraryDetailDto> {
  await named(inSpace(ctx, async (tx, spaceId) => {
    const w = await workflowOf(tx, spaceId, id, true);
    const d = await draftOf(tx, id);
    const { blocked, overrideOnly } = reviewRule(ctx, d as VersionRow, canEdit(ctx), EDITORS);
    if (blocked) throw new ApiError(d.makerId === ctx.user.id || d.submittedBy === ctx.user.id ? "self_approval" : d.status !== "in_review" ? "invalid_state" : "forbidden", blocked);
    const comment = b.comment?.trim() || null;
    if (overrideOnly && (!b.override || !comment)) throw new ApiError("self_approval", "You made this version. A Superadmin publishes their own version only by override, with a reason.");
    const spec = d.spec as ChainSpec;
    if (how === "reject") {
      if (!comment) throw new ApiError("bad_request", "Say why it goes back.");
      await tx.update(workflowVersions).set({ status: "draft", reviewComment: comment, decidedBy: ctx.user.id, decidedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(workflowVersions.id, d.id));
      await recordActivity(tx, ctx, { action: "workflow.reject", target: target(id, spec.name), after: { version: d.version, comment } });
      return;
    }
    if (w.archivedAt) throw new ApiError("invalid_state", "This workflow is archived. Its versions can't be published.");
    await tx.update(workflowVersions).set({ status: "retired", updatedAt: sql`now()` }).where(and(eq(workflowVersions.workflowId, id), eq(workflowVersions.status, "published")));
    await tx.update(workflowVersions).set({
      status: "published", decidedBy: ctx.user.id, decidedAt: sql`now()`, reviewComment: overrideOnly ? null : comment, overrideReason: overrideOnly ? comment : null, updatedAt: sql`now()`,
    }).where(eq(workflowVersions.id, d.id));
    await tx.update(workflows).set({ name: spec.name }).where(eq(workflows.id, id));
    await recordActivity(tx, ctx, { action: "workflow.publish", target: target(id, spec.name), after: { version: d.version, ...(overrideOnly ? { override: comment } : comment ? { comment } : {}) } });
  }));
  return workflowDetail(ctx, id);
}

/**
 * POST …/workflows/{id}/archive: refused while a recon version (live or open) of the space pins it. The workflow's row
 * is locked first; a recon version's submit/approve reads it FOR SHARE (recon checkApprovals), so one waits for the other.
 */
export async function archiveWorkflow(ctx: Ctx, id: string): Promise<LibraryDetailDto> {
  mustEdit(ctx);
  await inSpace(ctx, async (tx, spaceId) => {
    const w = await workflowOf(tx, spaceId, id, true);
    if (w.archivedAt) return;
    const using = await tx.select({ spec: reconConfigVersions.spec, name: reconConfigs.name }).from(reconConfigVersions)
      .innerJoin(reconConfigs, eq(reconConfigs.id, reconConfigVersions.configId)).where(pinsWhere(spaceId, id));
    if (using.length) {
      const where = [...new Set(using.flatMap((u) => pinsOf(u.spec as { approvals?: ReconApprovalSpec }, id).map((p) => `${u.name} · ${TRIGGER_LABEL[p.change]}`)))].join(", ");
      throw new ApiError("invalid_state", `Recons still use this workflow: ${where}. Change their approval setup first.`);
    }
    await tx.update(workflows).set({ archivedAt: sql`now()` }).where(and(eq(workflows.id, id), isNull(workflows.archivedAt)));
    await recordActivity(tx, ctx, { action: "workflow.archive", target: target(id, w.name), before: { archived: false }, after: { archived: true } });
  });
  return workflowDetail(ctx, id);
}

/**
 * For the recon module (checking an approval setup): the space's workflows by id (another space's are simply absent)
 * with the versions ever published and whether they are archived; each row read FOR SHARE so an archive in flight
 * finishes first.
 */
export async function workflowFacts(tx: InTx, spaceId: string, ids: readonly string[]): Promise<Map<string, { spaceId: string; name: string; archived: boolean; versions: Set<number> }>> {
  const out = new Map<string, { spaceId: string; name: string; archived: boolean; versions: Set<number> }>();
  if (!ids.length) return out;
  const ws = await tx.select().from(workflows).where(and(eq(workflows.spaceId, spaceId), inArray(workflows.id, [...new Set(ids)]))).for("share");
  const vs = await tx.select({ workflowId: workflowVersions.workflowId, version: workflowVersions.version }).from(workflowVersions)
    .where(and(inArray(workflowVersions.workflowId, ws.map((w) => w.id)), inArray(workflowVersions.status, ["published", "retired"])));
  for (const w of ws) out.set(w.id, { spaceId: w.spaceId, name: w.name, archived: !!w.archivedAt, versions: new Set(vs.filter((v) => v.workflowId === w.id).map((v) => v.version)) });
  return out;
}
/** A workflow's version (any status that was published once): its chain, for a request or a preview. */
export async function pinnedVersion(tx: InTx, ref: { id: string; version: number }): Promise<{ id: string; name: string; spec: ChainSpec } | null> {
  const [v] = await tx.select({ id: workflowVersions.id, spec: workflowVersions.spec }).from(workflowVersions)
    .where(and(eq(workflowVersions.workflowId, ref.id), eq(workflowVersions.version, ref.version), inArray(workflowVersions.status, ["published", "retired"])));
  return v ? { id: v.id, name: (v.spec as ChainSpec).name, spec: v.spec as ChainSpec } : null;
}
