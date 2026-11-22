// The breaks queue (Plan 5 Task 1, spec §11): a space's open breaks with who works them, how old they are and where
// they stand; assigning (space admin, reviewer), taking one for oneself (operator) and the working states. A break is a
// live recon item in status `break` (this module owns recon_items); its queue state is break_state (null = new) and
// assignee_id. Every change locks the items it changes, bumps their version (A1: the engine skips an item an operator
// changed meanwhile) and writes one activity entry per break changed; a bulk answers { done, skipped }.
import type { AssignBreaksBody, BreakListQuery, BreakRowDto, BreakStateBody, TakeBreaksBody } from "@starterkit/shared/contracts/breaks";
import type { BulkResult, FacetsDto, Page } from "@starterkit/shared/contracts/common";
import { isSuperadmin } from "@starterkit/shared/permissions";
import { AGE_BUCKETS, AGE_DAYS, type AgeBucket, type BreakState } from "@starterkit/shared/recon";
import { and, eq, ilike, inArray, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { InTx } from "../../kernel/db";
import type { ErrorCode } from "@starterkit/shared/contracts/common";
import { ApiError } from "../../kernel/errors";
import { countN, facetOf, likeEscape, one, pageQuery, sortSql } from "../../kernel/pagination";
import { recordActivity } from "../audit";
import type { Ctx } from "../auth";
import { records, todayIn } from "../ingest";
import { reconConfigs } from "../recon";
import { sources, sourceShares } from "../sources";
import { spaceMembers, withSpace } from "../spaces";
import { users } from "../users";
import { reconItems } from "./schema";
import { addDays } from "./service";

const inSpace = <T>(ctx: Ctx, fn: (tx: InTx, spaceId: string) => Promise<T>) =>
  withSpace({ spaceIds: [ctx.space!.id], userId: ctx.user.id }, (tx) => fn(tx, ctx.space!.id));

/** A live item of the space in status break that isn't resolved: a break of the queue. */
const queued = (spaceId: string) => and(eq(reconItems.spaceId, spaceId), eq(reconItems.status, "break"), isNull(reconItems.simRunId),
  or(isNull(reconItems.breakState), ne(reconItems.breakState, "resolved")));
const stateOf = (s: string | null): BreakState => (s ?? "new") as BreakState;
const DAY_MS = 86_400_000;

/** The spaces whose records a break of `spaceId` may stand on: its own, and those that share a source to it. */
async function recordSpaces(tx: InTx, spaceId: string): Promise<string[]> {
  const shared = await tx.selectDistinct({ id: sourceShares.spaceId }).from(sourceShares).where(eq(sourceShares.toSpaceId, spaceId));
  return [spaceId, ...shared.map((s) => s.id)];
}

type BreakFilter = Omit<BreakListQuery, "page" | "pageSize" | "sort">;
/** One age bucket as SQL on the item's business date (days before `today`). */
const inBucket = (today: string, b: AgeBucket) => {
  const [lo, hi] = AGE_DAYS[b];
  return and(sql`${reconItems.businessDate} <= ${addDays(today, -lo)}::date`, hi != null ? sql`${reconItems.businessDate} >= ${addDays(today, -hi)}::date` : undefined);
};
/** The queue filter: each filter's values OR'd, the filters AND'd; `q` = the record's reference (needs the records join). */
function breakWhere(ctx: Ctx, spaceId: string, today: string, q: BreakFilter) {
  const like = q.q?.trim() ? `%${likeEscape(q.q.trim())}%` : null;
  const any = <T>(vs: readonly T[] | undefined, f: (v: T) => SQL | undefined) => (vs?.length ? or(...vs.map(f)) : undefined);
  return and(
    queued(spaceId),
    q.recon?.length ? inArray(reconItems.configId, q.recon) : undefined,
    q.reason?.length ? inArray(reconItems.breakReason, q.reason) : undefined,
    any(q.state, (st) => (st === "new" ? isNull(reconItems.breakState) : eq(reconItems.breakState, st))),
    any(q.assignee, (a) => (a === "none" ? isNull(reconItems.assigneeId) : eq(reconItems.assigneeId, a === "me" ? ctx.user.id : a))),
    any(q.age, (b) => inBucket(today, b as AgeBucket)),
    like ? ilike(records.extRef, like) : undefined,
  );
}

/**
 * GET …/breaks/facets: the queue's counts per state, reason, age and assignee (Mine, Unassigned), each with the other
 * filters applied (the standard of every list's check filters).
 */
export function breakFacets(ctx: Ctx, q: BreakListQuery, now = new Date()): Promise<FacetsDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const today = todayIn(now);
    const spaces = await recordSpaces(tx, spaceId);
    const record = and(inArray(records.spaceId, spaces), eq(records.id, reconItems.recordId), eq(records.businessDate, reconItems.businessDate));
    const from = <S extends Record<string, unknown>>(sel: S, omit: keyof BreakFilter) => {
      const base = tx.select(sel as never).from(reconItems);
      return (q.q?.trim() ? base.leftJoin(records, record) : base).where(breakWhere(ctx, spaceId, today, { ...q, [omit]: undefined })).$dynamic();
    };
    const state = sql<string>`coalesce(${reconItems.breakState}, 'new')`;
    const age = sql<string>`case ${sql.join(AGE_BUCKETS.map((b) => sql`when ${inBucket(today, b)} then ${b}`), sql` `)} end`;
    const [byState, byReason, byAge, [who]] = await Promise.all([
      from({ v: state, n: countN }, "state").groupBy(state) as Promise<{ v: string; n: number }[]>,
      from({ v: reconItems.breakReason, n: countN }, "reason").groupBy(reconItems.breakReason) as Promise<{ v: string | null; n: number }[]>,
      from({ v: age, n: countN }, "age").groupBy(sql`1`) as Promise<{ v: string | null; n: number }[]>,
      from({ me: sql<number>`count(*) filter (where ${reconItems.assigneeId} = ${ctx.user.id})::int`, none: sql<number>`count(*) filter (where ${reconItems.assigneeId} is null)::int` }, "assignee") as Promise<{ me: number; none: number }[]>,
    ]);
    return { state: facetOf(byState), reason: facetOf(byReason), age: facetOf(byAge), assignee: { me: who?.me ?? 0, none: who?.none ?? 0 } };
  });
}

/** GET …/breaks: one page of the space's queue, oldest business date first unless `sort` says otherwise. */
export function breakPage(ctx: Ctx, q: BreakListQuery, now = new Date()): Promise<Page<BreakRowDto>> {
  return inSpace(ctx, async (tx, spaceId) => {
    const today = todayIn(now);
    const spaces = await recordSpaces(tx, spaceId);
    const record = and(inArray(records.spaceId, spaces), eq(records.id, reconItems.recordId), eq(records.businessDate, reconItems.businessDate));
    const like = q.q?.trim() ? `%${likeEscape(q.q.trim())}%` : null;
    const where = breakWhere(ctx, spaceId, today, q);
    // a proposal's item and its record (DEC-047), joined once for the page
    const pi = alias(reconItems, "pi"), pr = alias(records, "pr");
    const page = await pageQuery({
      rows: tx.select({
        id: reconItems.id, bd: reconItems.businessDate, configId: reconItems.configId, side: reconItems.side, reason: reconItems.breakReason,
        state: reconItems.breakState, assigneeId: reconItems.assigneeId, ref: records.extRef, amount: records.amountMinor, ccy: records.currency,
        recon: reconConfigs.name, source: sources.name, proposedRef: pr.extRef,
      }).from(reconItems)
        .innerJoin(reconConfigs, and(eq(reconConfigs.spaceId, reconItems.spaceId), eq(reconConfigs.id, reconItems.configId)))
        .leftJoin(records, record)
        .leftJoin(sources, and(eq(sources.spaceId, records.spaceId), eq(sources.id, records.sourceId)))
        .leftJoin(pi, and(eq(pi.spaceId, reconItems.spaceId), eq(pi.id, reconItems.proposedItemId)))
        .leftJoin(pr, and(inArray(pr.spaceId, spaces), eq(pr.id, pi.recordId), eq(pr.businessDate, pi.businessDate)))
        .where(where).$dynamic(),
      count: (like ? tx.select(one).from(reconItems).leftJoin(records, record) : tx.select(one).from(reconItems)).where(where).$dynamic(),
      orderBy: sortSql(q.sort, { businessDate: reconItems.businessDate }, "businessDate", reconItems.id),
      query: q,
      map: (r) => r,
      on: tx,
    });
    const ids = [...new Set(page.items.flatMap((r) => (r.assigneeId ? [r.assigneeId] : [])))];
    const names = new Map(ids.length ? (await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name]) : []);
    return {
      ...page,
      items: page.items.map((r) => ({
        id: r.id, businessDate: r.bd, recon: { id: r.configId, name: r.recon }, side: r.side as "a" | "b", source: r.source ?? null,
        ref: r.ref ?? null, amountMinor: r.amount === null || r.amount === undefined ? null : String(r.amount), currency: r.ccy ?? null,
        reason: r.reason, state: stateOf(r.state), assignee: r.assigneeId ? { id: r.assigneeId, name: names.get(r.assigneeId) ?? null } : null,
        ageDays: Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${r.bd}T00:00:00Z`)) / DAY_MS)),
        proposedRef: r.proposedRef ?? null,
      })),
    };
  });
}

type Locked = { id: string; bd: string; state: string | null; assigneeId: string | null; v: number; ref: string | null };

/**
 * The queue's breaks among `ids`, locked for this change (the rest: skipped `not_found`), then `apply` decides per
 * break: a new state and assignee, or why it is skipped. One activity entry per break changed.
 */
async function change(ctx: Ctx, ids: readonly string[], action: "break.assign" | "break.take" | "break.state",
  apply: (b: Locked) => { state: string | null; assigneeId: string | null } | ErrorCode): Promise<BulkResult> {
  return inSpace(ctx, async (tx, spaceId) => {
    const spaces = await recordSpaces(tx, spaceId);
    const rows = await tx.select({ id: reconItems.id, bd: reconItems.businessDate, state: reconItems.breakState, assigneeId: reconItems.assigneeId, v: reconItems.version, ref: records.extRef })
      .from(reconItems).leftJoin(records, and(inArray(records.spaceId, spaces), eq(records.id, reconItems.recordId), eq(records.businessDate, reconItems.businessDate)))
      .where(and(queued(spaceId), inArray(reconItems.id, [...ids]))).for("update", { of: reconItems });
    const found = new Map(rows.map((r) => [r.id, r]));
    const done: string[] = [], skipped: { id: string; code: string }[] = [];
    for (const id of ids) {
      const b = found.get(id);
      if (!b) { skipped.push({ id, code: "not_found" }); continue; }
      const next = apply(b);
      if (typeof next === "string") { skipped.push({ id, code: next }); continue; }
      if (next.state === b.state && next.assigneeId === b.assigneeId) { done.push(id); continue; }
      await tx.update(reconItems).set({ breakState: next.state, assigneeId: next.assigneeId, stateAt: sql`now()`, version: sql`${reconItems.version} + 1` })
        .where(and(eq(reconItems.spaceId, spaceId), eq(reconItems.id, id), eq(reconItems.businessDate, b.bd), eq(reconItems.version, b.v)));
      await recordActivity(tx, ctx, {
        action, target: { type: "break", id, label: b.ref ?? "Unmatch item" },
        before: action === "break.state" ? { state: stateOf(b.state) } : { assignee: b.assigneeId, state: stateOf(b.state) },
        after: action === "break.state" ? { state: stateOf(next.state) } : { assignee: next.assigneeId, state: stateOf(next.state) },
      });
      done.push(id);
    }
    return { done, skipped };
  });
}

/** A break someone works is `assigned` (or further); back with nobody it is new again. A resolved one never moves here. */
const WORKING = new Set(["assigned", "investigating", "pending_external"]);

/**
 * POST …/breaks/assign (space admin, reviewer): to a member of the space, or back to Unassigned (null). A break
 * pending approval or proposed for resolution keeps its state; one working stays working with its new assignee.
 */
export async function assignBreaks(ctx: Ctx, b: AssignBreaksBody): Promise<BulkResult> {
  if (b.assigneeId) {
    const member = await inSpace(ctx, (tx, spaceId) => tx.select({ id: spaceMembers.userId }).from(spaceMembers)
      .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, b.assigneeId!))).limit(1));
    if (!member.length) throw new ApiError("bad_request", "Assign items to a member of this space.");
  }
  return change(ctx, b.ids, "break.assign", (x) => {
    if (x.state === "pending_approval" || x.state === "proposed_resolution") return "invalid_state";
    return { assigneeId: b.assigneeId, state: b.assigneeId ? (x.state && WORKING.has(x.state) ? x.state : "assigned") : null };
  });
}

/** POST …/breaks/take: the caller takes breaks nobody has (one somebody has is skipped invalid_state; a reviewer reassigns it). */
export function takeBreaks(ctx: Ctx, b: TakeBreaksBody): Promise<BulkResult> {
  return change(ctx, b.ids, "break.take", (x) => (x.assigneeId && x.assigneeId !== ctx.user.id ? "invalid_state" : { assigneeId: ctx.user.id, state: x.state ?? "assigned" }));
}

/**
 * POST …/breaks/state: investigating or pending external, for breaks the caller has; a space admin or reviewer (and a
 * Superadmin) may move anyone's. A break nobody has is taken first (skipped invalid_state).
 */
export function setBreakState(ctx: Ctx, b: BreakStateBody): Promise<BulkResult> {
  const lead = isSuperadmin(ctx.user.roles) || ctx.space!.roles.some((r) => r === "space_admin" || r === "reviewer");
  return change(ctx, b.ids, "break.state", (x) => {
    if (!x.assigneeId || (x.state && !WORKING.has(x.state))) return "invalid_state";
    if (x.assigneeId !== ctx.user.id && !lead) return "forbidden";
    return { assigneeId: x.assigneeId, state: b.state };
  });
}
