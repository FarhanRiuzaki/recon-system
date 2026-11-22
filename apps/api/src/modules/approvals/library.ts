// The global workflow library (DEC-052 revision, spec docs/superpowers/specs/2026-11-22-workflow-library-and-bindings-design.md
// §4.2): named chains of levels, versioned. Only workflow.manage holders create and edit them; another one publishes (a
// Superadmin their own only by override, with a reason). Spaces' approval rules pick them; "Used by" lists which, across
// every space, with the levels that would lack people there. No space owns a workflow: no row level security.
import type {
  ChainSpec, ChainVersionDto, CreateWorkflowBody, LibraryDetailDto, LibraryRowDto, ReviewWorkflowBody, SaveChainBody, UsedByRowDto,
} from "@starterkit/shared/contracts/workflows";
import type { Page } from "@starterkit/shared/contracts/common";
import type { UsedByQuery, WorkflowListQuery } from "@starterkit/shared/contracts/workflows";
import { ChainSpec as ChainSchema } from "@starterkit/shared/contracts/workflows";
import { TRIGGER_LABEL, type BindingSpecShape, type Level, type Trigger, groupNeeds } from "@starterkit/shared/workflows";
import { and, eq, ilike, inArray, isNull, max, or, sql } from "drizzle-orm";
import { db, type InTx } from "../../kernel/db";
import { ApiError, isUniqueViolation, notFound } from "../../kernel/errors";
import { likeEscape, pageQuery, sortSql } from "../../kernel/pagination";
import { recordActivity } from "../audit";
import type { Ctx } from "../auth";
import { roles } from "../rbac";
import { spaces, withSpace } from "../spaces";
import { approversOf } from "./requests";
import { approvalBindings, workflows, workflowVersions } from "./schema";
import { reviewRule, userNames, type VersionRow, versionDto, versionPeople } from "./versions";

type Row = typeof workflowVersions.$inferSelect;
const EDITORS = "a workflow manager";
export const canManage = (ctx: Ctx) => ctx.perms.has("workflow.manage");
const mustManage = (ctx: Ctx) => { if (!canManage(ctx)) throw new ApiError("forbidden", "Only a workflow manager edits the workflow library."); };
const target = (id: string, name: string) => ({ type: "workflow", id, label: name });
const DUPLICATE = "A workflow with this name exists. Pick another name.";

async function versionsOf(tx: InTx, workflowId: string) {
  const rows = await tx.select().from(workflowVersions).where(and(eq(workflowVersions.workflowId, workflowId), inArray(workflowVersions.status, ["draft", "in_review", "published"])));
  return { published: rows.find((r) => r.status === "published") ?? null, open: rows.find((r) => r.status === "draft" || r.status === "in_review") ?? null };
}
async function workflowOf(tx: InTx, id: string, lock = false) {
  const q = tx.select().from(workflows).where(eq(workflows.id, id));
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

/** Approval rules versions (published or open) that use one of `workflowIds`. */
const usingWhere = (workflowIds: readonly string[]) => and(inArray(approvalBindings.status, ["draft", "in_review", "published"]), or(...workflowIds.flatMap((id) => [
  sql`${approvalBindings.spec}->'rules' @> jsonb_build_array(jsonb_build_object('workflowId', ${id}::text))`, sql`${approvalBindings.spec}->>'otherwise' = ${id}`,
])));
/** Runs `fn` with every space visible: the library is global, and so is what uses it. */
async function acrossSpaces<T>(fn: (tx: InTx) => Promise<T>, empty: T): Promise<T> {
  const ids = (await db.select({ id: spaces.id }).from(spaces)).map((s) => s.id);
  return ids.length ? withSpace({ spaceIds: ids, userId: null }, fn) : empty;
}
/** Every space's approval rules versions (published or open) that use `workflowIds`, with the space's name. */
async function rulesUsing(workflowIds: readonly string[]) {
  if (!workflowIds.length) return [];
  return acrossSpaces(async (tx) => (await tx.select({ b: approvalBindings, spaceName: spaces.name }).from(approvalBindings).innerJoin(spaces, eq(spaces.id, approvalBindings.spaceId)).where(usingWhere(workflowIds)))
    .map((r) => ({ ...r.b, spaceName: r.spaceName, spec: r.b.spec as BindingSpecShape })), []);
}
const usesOf = (spec: BindingSpecShape, id: string) => [...spec.rules.filter((r) => r.workflowId === id).map((r) => r.name), ...(spec.otherwise === id ? ["Otherwise"] : [])];

/** GET /v1/workflows. */
export async function libraryPage(q: WorkflowListQuery): Promise<Page<LibraryRowDto>> {
  const where = q.q ? ilike(workflows.name, `%${likeEscape(q.q)}%`) : undefined;
  const page = await pageQuery({
    rows: db.select().from(workflows).where(where).$dynamic(), count: db.select({ id: workflows.id }).from(workflows).where(where).$dynamic(),
    orderBy: sortSql(q.sort, { name: sql`lower(${workflows.name})`, createdAt: workflows.createdAt }, "name", workflows.id), query: q, map: (w) => w,
  });
  const ids = page.items.map((w) => w.id);
  const versions = ids.length ? await db.select().from(workflowVersions).where(and(inArray(workflowVersions.workflowId, ids), inArray(workflowVersions.status, ["draft", "in_review", "published"]))) : [];
  const using = await rulesUsing(ids);
  return {
    ...page,
    items: page.items.map((w) => {
      const pub = versions.find((v) => v.workflowId === w.id && v.status === "published");
      const open = versions.find((v) => v.workflowId === w.id && v.status !== "published");
      const spec = (pub ?? open)?.spec as ChainSpec | undefined;
      const mine = using.filter((r) => r.status === "published" && usesOf(r.spec, w.id).length);
      return {
        id: w.id, name: w.name, levels: spec?.levels.length ?? 0, archived: !!w.archivedAt,
        published: pub ? { version: pub.version, decidedAt: pub.decidedAt?.toISOString() ?? null } : null,
        open: open ? { version: open.version, status: open.status as "draft" | "in_review", updatedAt: open.updatedAt.toISOString() } : null,
        rulesUsing: mine.length, spacesUsing: new Set(mine.map((r) => r.spaceId)).size, updatedAt: ((open ?? pub)?.updatedAt ?? w.createdAt).toISOString(),
      };
    }),
  };
}

/** GET /v1/workflows/{id}. */
export function libraryDetail(ctx: Ctx, id: string): Promise<LibraryDetailDto> {
  return db.transaction(async (tx) => {
    const w = await workflowOf(tx, id);
    const { published, open } = await versionsOf(tx, id);
    const named = [published, open].flatMap((r) => (r ? (r.spec as ChainSpec).levels.flatMap((l) => l.groups.flatMap((g) => g.users)) : []));
    const n = await userNames(tx, [...named, ...versionPeople(published), ...versionPeople(open)]);
    const globalRoles = (await tx.select({ name: roles.name }).from(roles).orderBy(sql`lower(${roles.name})`)).map((r) => r.name);
    const { blocked, overrideOnly } = reviewRule(ctx, open as VersionRow | null, canManage(ctx), EDITORS);
    return {
      id: w.id, name: w.name, archived: !!w.archivedAt, globalRoles,
      published: published ? versionDto<ChainSpec>(published, n) as ChainVersionDto : null, open: open ? versionDto<ChainSpec>(open, n) as ChainVersionDto : null,
      people: [...new Set(named)].map((u) => ({ id: u, name: n.get(u) ?? null })), canEdit: canManage(ctx), reviewBlocked: blocked, overrideOnly,
    };
  });
}

/** GET /v1/workflows/{id}/used-by: the approval rules that use it, and the levels that would lack people in each space. */
export async function usedBy(id: string, q: UsedByQuery): Promise<Page<UsedByRowDto>> {
  const levels = await db.transaction(async (tx) => {
    await workflowOf(tx, id);
    const { published, open } = await versionsOf(tx, id);
    return ((open ?? published)?.spec as ChainSpec | undefined)?.levels ?? [];
  });
  const empty: Page<UsedByRowDto> = { items: [], total: 0, page: q.page, pageSize: q.pageSize };
  return acrossSpaces(async (tx) => {
    const where = usingWhere([id]);
    const page = await pageQuery({
      rows: tx.select({ b: approvalBindings, spaceName: spaces.name }).from(approvalBindings).innerJoin(spaces, eq(spaces.id, approvalBindings.spaceId)).where(where).$dynamic(),
      count: tx.select({ id: approvalBindings.id }).from(approvalBindings).where(where).$dynamic(),
      orderBy: [sql`lower(${spaces.name})`, sql`${approvalBindings.trigger}`, sql`${approvalBindings.version}`, sql`${approvalBindings.id}`], query: q, map: (r) => r, on: tx,
    });
    const items: UsedByRowDto[] = [];
    for (const { b, spaceName } of page.items) {
      items.push({
        spaceId: b.spaceId, spaceName, trigger: b.trigger as Trigger, ruleName: usesOf(b.spec as BindingSpecShape, id).join(", "), rulesVersion: b.version,
        rulesStatus: b.status as UsedByRowDto["rulesStatus"], short: await shortLevels(tx, b.spaceId, levels),
      });
    }
    return { ...page, items };
  }, empty);
}

const named = async <T>(p: Promise<T>): Promise<T> => p.catch((e) => { throw isUniqueViolation(e) ? new ApiError("duplicate", DUPLICATE) : e; });

/** POST /v1/workflows: a new workflow and its first draft. */
export async function createWorkflow(ctx: Ctx, b: CreateWorkflowBody): Promise<LibraryDetailDto> {
  mustManage(ctx);
  const id = Bun.randomUUIDv7();
  await named(db.transaction(async (tx) => {
    await tx.insert(workflows).values({ id, name: b.spec.name });
    await tx.insert(workflowVersions).values({ id: Bun.randomUUIDv7(), workflowId: id, version: 1, status: "draft", spec: b.spec, makerId: ctx.user.id });
    await recordActivity(tx, ctx, { action: "workflow.create", target: target(id, b.spec.name), after: { name: b.spec.name, levels: b.spec.levels.length } });
  }));
  return libraryDetail(ctx, id);
}

/** POST /v1/workflows/{id}/draft: a new draft from the live version, unless one is open. */
export async function startWorkflowDraft(ctx: Ctx, id: string): Promise<LibraryDetailDto> {
  mustManage(ctx);
  await db.transaction(async (tx) => {
    const w = await workflowOf(tx, id, true);
    if (w.archivedAt) throw new ApiError("invalid_state", "This workflow is archived.");
    const { published, open } = await versionsOf(tx, id);
    if (open) throw new ApiError("invalid_state", open.status === "draft" ? "A draft of this workflow is open already." : "A version of this workflow waits for approval.");
    const [m] = await tx.select({ v: max(workflowVersions.version) }).from(workflowVersions).where(eq(workflowVersions.workflowId, id));
    const version = (m?.v ?? 0) + 1;
    try {
      await tx.insert(workflowVersions).values({ id: Bun.randomUUIDv7(), workflowId: id, version, status: "draft", spec: published!.spec, makerId: ctx.user.id });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError("invalid_state", "A draft of this workflow is open already.");
      throw e;
    }
    await recordActivity(tx, ctx, { action: "workflow.save", target: target(id, w.name), after: { version, from: published?.version ?? null } });
  });
  return libraryDetail(ctx, id);
}

/** The open version, locked; 409 when none. */
async function draftOf(tx: InTx, id: string): Promise<Row> {
  const [d] = await tx.select().from(workflowVersions).where(and(eq(workflowVersions.workflowId, id), inArray(workflowVersions.status, ["draft", "in_review"]))).for("update");
  if (!d) throw new ApiError("invalid_state", "This workflow has no open draft. Start one first.");
  return d;
}
const hasPublished = async (tx: InTx, id: string) => (await tx.select({ id: workflowVersions.id }).from(workflowVersions).where(and(eq(workflowVersions.workflowId, id), eq(workflowVersions.status, "published")))).length > 0;

/** PATCH /v1/workflows/{id}/draft (autosave); no entry when nothing changed. A never-published workflow takes the draft's name. */
export async function saveWorkflowDraft(ctx: Ctx, id: string, b: SaveChainBody): Promise<LibraryDetailDto> {
  mustManage(ctx);
  await named(db.transaction(async (tx) => {
    const w = await workflowOf(tx, id, true);
    const d = await draftOf(tx, id);
    if (d.status !== "draft") throw new ApiError("invalid_state", "This version waits for approval and can't change. Ask for it back to edit it.");
    if (JSON.stringify(d.spec) === JSON.stringify(b.spec)) return;
    await tx.update(workflowVersions).set({ spec: b.spec, updatedAt: sql`now()`, reviewComment: null }).where(eq(workflowVersions.id, d.id));
    if (!(await hasPublished(tx, id)) && w.name !== b.spec.name) await tx.update(workflows).set({ name: b.spec.name }).where(eq(workflows.id, id));
    await recordActivity(tx, ctx, { action: "workflow.save", target: target(id, b.spec.name), after: { version: d.version, levels: b.spec.levels.length } });
  }));
  return libraryDetail(ctx, id);
}

/** POST /v1/workflows/{id}/draft/submit. */
export async function submitWorkflowDraft(ctx: Ctx, id: string): Promise<LibraryDetailDto> {
  mustManage(ctx);
  await db.transaction(async (tx) => {
    const w = await workflowOf(tx, id, true);
    const d = await draftOf(tx, id);
    if (d.status !== "draft") throw new ApiError("invalid_state", "This version waits for approval already.");
    ChainSchema.parse(d.spec);
    await tx.update(workflowVersions).set({ status: "in_review", submittedBy: ctx.user.id, submittedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(workflowVersions.id, d.id));
    await recordActivity(tx, ctx, { action: "workflow.submit", target: target(id, w.name), after: { version: d.version } });
  });
  return libraryDetail(ctx, id);
}

/** POST /v1/workflows/{id}/draft/discard: the draft goes; a workflow never published goes with it. Answers null then. */
export async function discardWorkflowDraft(ctx: Ctx, id: string): Promise<LibraryDetailDto | null> {
  mustManage(ctx);
  const gone = await db.transaction(async (tx) => {
    const w = await workflowOf(tx, id, true);
    const d = await draftOf(tx, id);
    if (d.status !== "draft") throw new ApiError("invalid_state", "This version waits for approval. Send it back to discard it.");
    await tx.delete(workflowVersions).where(eq(workflowVersions.id, d.id));
    const last = !(await hasPublished(tx, id));
    if (last) await tx.delete(workflows).where(eq(workflows.id, id));
    await recordActivity(tx, ctx, { action: "workflow.discard", target: target(id, w.name), before: { version: d.version } });
    return last;
  });
  return gone ? null : libraryDetail(ctx, id);
}

/** POST /v1/workflows/{id}/review/approve|reject. Publishing names the workflow after its new version. */
export async function reviewWorkflowDraft(ctx: Ctx, id: string, b: ReviewWorkflowBody, how: "approve" | "reject"): Promise<LibraryDetailDto> {
  await named(db.transaction(async (tx) => {
    await workflowOf(tx, id, true);
    const d = await draftOf(tx, id);
    const { blocked, overrideOnly } = reviewRule(ctx, d as VersionRow, canManage(ctx), EDITORS);
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
    await tx.update(workflowVersions).set({ status: "retired", updatedAt: sql`now()` }).where(and(eq(workflowVersions.workflowId, id), eq(workflowVersions.status, "published")));
    await tx.update(workflowVersions).set({
      status: "published", decidedBy: ctx.user.id, decidedAt: sql`now()`, reviewComment: overrideOnly ? null : comment, overrideReason: overrideOnly ? comment : null, updatedAt: sql`now()`,
    }).where(eq(workflowVersions.id, d.id));
    await tx.update(workflows).set({ name: spec.name }).where(eq(workflows.id, id));
    await recordActivity(tx, ctx, { action: "workflow.publish", target: target(id, spec.name), after: { version: d.version, ...(overrideOnly ? { override: comment } : comment ? { comment } : {}) } });
  }));
  return libraryDetail(ctx, id);
}

/** POST /v1/workflows/{id}/archive: refused while a space's live or open approval rules use it. */
export async function archiveWorkflow(ctx: Ctx, id: string): Promise<LibraryDetailDto> {
  mustManage(ctx);
  const using = await rulesUsing([id]);
  if (using.length) {
    const where = [...new Set(using.map((r) => `${r.spaceName} · ${TRIGGER_LABEL[r.trigger as Trigger]}`))].join(", ");
    throw new ApiError("invalid_state", `Approval rules still use this workflow: ${where}. Change them first.`);
  }
  await db.transaction(async (tx) => {
    const w = await workflowOf(tx, id, true);
    if (w.archivedAt) return;
    await tx.update(workflows).set({ archivedAt: sql`now()` }).where(and(eq(workflows.id, id), isNull(workflows.archivedAt)));
    await recordActivity(tx, ctx, { action: "workflow.archive", target: target(id, w.name), before: { archived: false }, after: { archived: true } });
  });
  return libraryDetail(ctx, id);
}

/** The library a space's approval rules may pick: live, not archived workflows, by name. */
export async function liveLibrary(tx: InTx): Promise<{ id: string; name: string; levels: number; spec: ChainSpec; versionId: string }[]> {
  const rows = await tx.select({ id: workflows.id, name: workflows.name, spec: workflowVersions.spec, versionId: workflowVersions.id }).from(workflows)
    .innerJoin(workflowVersions, and(eq(workflowVersions.workflowId, workflows.id), eq(workflowVersions.status, "published")))
    .where(isNull(workflows.archivedAt)).orderBy(sql`lower(${workflows.name})`);
  return rows.map((r) => ({ ...r, spec: r.spec as ChainSpec, levels: (r.spec as ChainSpec).levels.length }));
}
/** A workflow's live version (archived or not: a rules version published before an archive was refused can't point at one). */
export async function liveVersion(tx: InTx, workflowId: string): Promise<{ id: string; spec: ChainSpec } | null> {
  const [v] = await tx.select({ id: workflowVersions.id, spec: workflowVersions.spec }).from(workflowVersions).where(and(eq(workflowVersions.workflowId, workflowId), eq(workflowVersions.status, "published")));
  return v ? { id: v.id, spec: v.spec as ChainSpec } : null;
}
