// Operation result (docs/superpowers/specs/2026-11-24-operation-result-design.md, approach 1: a live query over the
// engine's tables). One row per result of a recon in a business-date range: a live match group (not reversed, not a
// simulation's) dated by its business date, or an item no live group holds, dated by its own. Its overall status is
// the spec's table (resultStatus in packages/shared/src/results.ts), computed here in SQL for the filter, sort and
// counts; the page's rows carry the TypeScript one (the integration test checks both agree on every row). Inputs per
// item: its status and resolution, a proposed counterpart, a pending request (approval_requests, its main item or one
// of `item_ids`), the latest posting run (its own action_runs row of kind posting, or its posting group's: an open
// group = `grouped`, a closed one its run). Cells are filled only for the page's rows.
// ponytail: every request aggregates the whole range (counts and sort by status need it); a per-day count kept by the
// engine if the volume test or production says so (spec "Volume").
import type { Page } from "@starterkit/shared/contracts/common";
import type { ResultCell, ResultColumn, ResultCountsDto, ResultFieldDto, ResultListQuery, ResultMemberDto, ResultMembersDto, ResultMembersQuery, ResultRowDto } from "@starterkit/shared/contracts/results";
import type { RequestKind } from "@starterkit/shared/approvals";
import { FIELD_LABEL, type GroupKind, type ItemStatus, type Resolution } from "@starterkit/shared/recon";
import { RESULT_MEMBERS_MAX, RESULT_STATUSES, type PostingStatus, type ResultStatus, resultStatus, type SideState } from "@starterkit/shared/results";
import { DEBIT_CODES } from "@starterkit/shared/sources";
import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, isNull, lte, notExists, or, type SQL, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { InTx } from "../../kernel/db";
import { notFound } from "../../kernel/errors";
import { COUNT_CAP, countN, likeEscape, one, pageQuery, sortSql } from "../../kernel/pagination";
import { approvalRequests } from "../approvals";
import type { Ctx } from "../auth";
import { records, todayIn } from "../ingest";
import { actionRuns, postingGroupItems, postingGroups } from "../integrations";
import { resultColumnsOf, type ResultColumnsOf } from "../recon";
import { users } from "../users";
import { inSpace, recordSpaces } from "./break-resolve";
import { matchGroups, matchMembers, reconItems } from "./schema";

type Filter = Omit<ResultListQuery, "page" | "pageSize">;
const as = <T>(e: SQL | SQL.Aliased | unknown, name: string) => sql<T>`${e}`.as(name);
const lit = (v: string) => sql`${v}`;
const inList = (e: SQL | unknown, vs: readonly string[]) => sql`${e} in (${sql.join(vs.map(lit), sql`, `)})`;

/** The business dates a query reads: dateFrom..dateTo, one of them alone that day, none today (Asia/Jakarta). */
function datesOf(q: Filter, now: Date): [string, string] {
  const today = todayIn(now);
  return [q.dateFrom ?? q.dateTo ?? today, q.dateTo ?? q.dateFrom ?? today];
}

/** A live group of the config holding item `item` (the item is not a lone row then). */
const inLiveGroup = (tx: InTx, spaceId: string, item: SQL | unknown) =>
  tx.select(one).from(matchMembers).innerJoin(matchGroups, and(eq(matchGroups.spaceId, matchMembers.spaceId), eq(matchGroups.id, matchMembers.groupId)))
    .where(and(eq(matchMembers.spaceId, spaceId), sql`${matchMembers.itemId} = ${item}`, isNull(matchGroups.reversedBy), isNull(matchGroups.simRunId)));

/**
 * The latest posting run of each item of the recon that has one, as the Unmatch item page reads it (breakOf in
 * break-resolve.ts, runsOf in integrations/actions.ts): only the runs of the item's latest request (by `requested_at`;
 * the item its main one or one of `item_ids`), its own and the ones made once for the whole request (`item_id` null),
 * then the posting groups it joined there (the group's run once it has one, else `grouped`); the last in runsOf's order
 * (groups after own runs, each by sending order). Read from the recon's requests (index on space, recon, item) and
 * their runs by request, never the space's other recons; `items` = only those items (a page's).
 * ponytail: every request of the recon is read (a hash join to the range's rows); joined per item instead it cost over
 * a second at 930,000 rows. Bound by a request date if a recon's history outgrows that.
 */
function latestPostings(tx: InTx, spaceId: string, configId: string, items?: string[]) {
  const ofRecon = and(eq(approvalRequests.spaceId, spaceId), eq(approvalRequests.configId, configId));
  const asMain = tx.select({ item: as<string>(approvalRequests.itemId, "h_item"), rq: as<string>(approvalRequests.id, "h_rq"), at: as<Date>(approvalRequests.requestedAt, "h_at") })
    .from(approvalRequests).where(and(ofRecon, items ? inArray(approvalRequests.itemId, items) : undefined));
  // the other items of a request (a force match's), one row each
  const asOther = tx.select({ item: as<string>(sql`unnest(${approvalRequests.itemIds})`, "h_item"), rq: as<string>(approvalRequests.id, "h_rq"), at: as<Date>(approvalRequests.requestedAt, "h_at") })
    .from(approvalRequests).where(and(ofRecon, sql`cardinality(${approvalRequests.itemIds}) > 0`));
  const held = asMain.unionAll(asOther).as("lh");
  const latestRequest = () => tx.selectDistinctOn([held.item], { item: as<string>(held.item, "lr_item"), rq: as<string>(held.rq, "lr_rq") }).from(held)
    .where(items ? inArray(held.item, items) : undefined).orderBy(held.item, desc(held.at)).as("lr");
  const lr1 = latestRequest(), lr2 = latestRequest();
  const own = tx.select({
    item: as<string>(lr1.item, "r_item"), st: as<string>(actionRuns.status, "st"), at: as<Date>(actionRuns.createdAt, "at"), bank: as<string | null>(actionRuns.bankReference, "bank"),
    g: as<number>(sql`0`, "g"), k: as<number>(actionRuns.seq, "k"),
  }).from(lr1).innerJoin(actionRuns, and(eq(actionRuns.spaceId, spaceId), eq(actionRuns.requestId, lr1.rq), eq(actionRuns.kind, "posting"), or(eq(actionRuns.itemId, lr1.item), isNull(actionRuns.itemId))));
  const run = alias(actionRuns, "grun");
  const grouped = tx.select({
    item: as<string>(lr2.item, "r_item"), st: as<string>(sql`case when ${run.id} is null then 'grouped' else ${run.status} end`, "st"),
    at: as<Date>(sql`coalesce(${run.createdAt}, ${postingGroupItems.joinedAt})`, "at"), bank: as<string | null>(run.bankReference, "bank"),
    g: as<number>(sql`1`, "g"), k: as<number>(postingGroupItems.actionIndex, "k"),
  }).from(lr2)
    .innerJoin(postingGroupItems, and(eq(postingGroupItems.spaceId, spaceId), eq(postingGroupItems.requestId, lr2.rq), eq(postingGroupItems.itemId, lr2.item)))
    .innerJoin(postingGroups, eq(postingGroups.id, postingGroupItems.groupId))
    .leftJoin(run, and(eq(run.spaceId, postingGroups.spaceId), eq(run.id, postingGroups.runId)))
    .where(or(isNull(run.id), eq(run.kind, "posting")));
  const runs = own.unionAll(grouped).as("pr");
  return tx.selectDistinctOn([runs.item], { itemId: as<string>(runs.item, "lp_item"), st: as<string>(runs.st, "lp_st"), bank: as<string | null>(runs.bank, "lp_bank"), at: as<Date>(runs.at, "lp_at") })
    .from(runs).orderBy(runs.item, desc(runs.g), desc(runs.k));
}

/**
 * Working memory for this transaction's reads (statement-local, like the engine's own timeout): with the default 4 MB
 * PostgreSQL walks the groups and their members by index (over 3 s at 930,000 rows) instead of hashing them (about
 * 1.5 s). ponytail: 64 MB per hash or sort of one request; a per-day count kept by the engine if many read at once.
 */
const roomToAggregate = (tx: InTx) => tx.execute(sql`select set_config('work_mem', '64MB', true)`);

/** The row an item stands in: its live group, else itself (a lone item). */
const rowOf = (tx: InTx, spaceId: string, item: SQL | unknown) => sql<string>`coalesce((${tx.select({ id: matchGroups.id }).from(matchMembers)
  .innerJoin(matchGroups, and(eq(matchGroups.spaceId, matchMembers.spaceId), eq(matchGroups.id, matchMembers.groupId)))
  .where(and(eq(matchMembers.spaceId, spaceId), sql`${matchMembers.itemId} = ${item}`, isNull(matchGroups.reversedBy), isNull(matchGroups.simRunId))).limit(1)}), ${item})`;

/** The first resolution of `col`'s, in the status table's order (an aggregate). */
const RES_ORDER: Resolution[] = ["POSTED", "WRITTEN_OFF", "ADJUSTED", "DUPLICATE", "NO_ACTION", "FORCE_MATCHED", "MATCHED_MANUAL", "AUTO_MATCHED_LATE_DATA"];
const firstResolution = (col: SQL | unknown) => sql`case ${sql.join(RES_ORDER.map((r) => sql`when bool_or(${col} = ${r}) then ${r}`), sql` `)} end`;

/**
 * Every result row of the range with its status inputs (`rows`), in two selects. A live group of the range: its members
 * counted per side (match_members alone) and the resolution of its members that have one (the few resolved items, not
 * every member's item). An item of the range no live group holds: its own status. Then each row's pending request and
 * latest posting run (latestPostings), both of the few items that have one, mapped to their row (rowOf). `q` keeps the
 * rows holding a record whose reference has it (those records found first); the sorts by amount A and reference join
 * every item's record (`withRecords`).
 */
function resultRows(tx: InTx, spaceId: string, configId: string, spaces: string[], [from, to]: [string, string], q: Filter) {
  const live = and(eq(reconItems.spaceId, spaceId), eq(reconItems.configId, configId), isNull(reconItems.simRunId));
  const withRecords = /^-?(amountA|ref)$/.test(q.sort ?? "");
  const signed = sql`case when upper(btrim(coalesce(${records.direction}, ''))) in (${sql.join(DEBIT_CODES.map(lit), sql`, `)}) then -${records.amountMinor} else ${records.amountMinor} end`;
  const recordOf = and(inArray(records.spaceId, spaces), eq(records.id, reconItems.recordId), eq(records.businessDate, reconItems.businessDate));

  // q: the items whose record's reference holds it (a member is never dated after the range's end)
  const like = q.q?.trim() ? `%${likeEscape(q.q.trim())}%` : null;
  const hit = alias(reconItems, "hit");
  const hits = like ? tx.select({ id: hit.id }).from(hit)
    .innerJoin(records, and(inArray(records.spaceId, spaces), eq(records.id, hit.recordId), eq(records.businessDate, hit.businessDate), ilike(records.extRef, like)))
    .where(and(eq(hit.spaceId, spaceId), eq(hit.configId, configId), isNull(hit.simRunId), lte(hit.businessDate, to))) : null;

  // the resolution of each group's members that have one
  const resolved = tx.select({ groupId: as<string>(matchMembers.groupId, "rg_group"), res: as<Resolution>(firstResolution(reconItems.resolution), "rg_res") })
    .from(reconItems).innerJoin(matchMembers, and(eq(matchMembers.spaceId, reconItems.spaceId), eq(matchMembers.itemId, reconItems.id)))
    .where(and(live, isNotNull(reconItems.resolution), lte(reconItems.businessDate, to))).groupBy(matchMembers.groupId).as("rg");
  const groupBase = tx.select({
    rowId: as<string>(matchGroups.id, "row_id"), kind: as<"group" | "item">(sql`'group'`, "kind"), bd: as<string>(matchGroups.businessDate, "bd"),
    gk: as<string | null>(matchGroups.kind, "gk"), gpass: as<number | null>(matchGroups.passNo, "gpass"), runId: as<string | null>(matchGroups.runId, "run_id"),
    nA: as<number>(sql`(count(*) filter (where ${matchMembers.side} = 'a'))::int`, "n_a"), nB: as<number>(sql`(count(*) filter (where ${matchMembers.side} = 'b'))::int`, "n_b"),
    res: as<Resolution | null>(sql`null::text`, "res_row"), ist: as<ItemStatus | null>(sql`null::text`, "ist_row"), itemSide: as<string | null>(sql`null::text`, "item_side"),
    proposed: as<boolean>(sql`false`, "proposed_row"), openable: as<boolean>(sql`false`, "openable"),
    ...(withRecords ? {
      amountA: as<string>(sql`(coalesce(sum(${signed}) filter (where ${matchMembers.side} = 'a'), 0))::text`, "amount_a"),
      refSort: as<string | null>(sql`coalesce(min(${records.extRef}) filter (where ${matchMembers.side} = 'a'), min(${records.extRef}) filter (where ${matchMembers.side} = 'b'))`, "ref_sort"),
    } : {}),
  }).from(matchGroups)
    .innerJoin(matchMembers, and(eq(matchMembers.spaceId, matchGroups.spaceId), eq(matchMembers.groupId, matchGroups.id)))
    .$dynamic();
  // a member is never dated after its group (the group's date is the latest of its members'): prunes later partitions
  const groupJoined = withRecords
    ? groupBase.innerJoin(reconItems, and(live, eq(reconItems.id, matchMembers.itemId), lte(reconItems.businessDate, matchGroups.businessDate))).leftJoin(records, recordOf)
    : groupBase;
  const groups = groupJoined.where(and(eq(matchGroups.spaceId, spaceId), eq(matchGroups.configId, configId), isNull(matchGroups.simRunId), isNull(matchGroups.reversedBy),
    gte(matchGroups.businessDate, from), lte(matchGroups.businessDate, to),
    hits ? inArray(matchGroups.id, tx.select({ id: matchMembers.groupId }).from(matchMembers).where(and(eq(matchMembers.spaceId, spaceId), inArray(matchMembers.itemId, hits)))) : undefined))
    .groupBy(matchGroups.id, matchGroups.businessDate, matchGroups.kind, matchGroups.passNo, matchGroups.runId);
  const loneBase = tx.select({
    rowId: as<string>(reconItems.id, "row_id"), kind: as<"group" | "item">(sql`'item'`, "kind"), bd: as<string>(reconItems.businessDate, "bd"),
    gk: as<string | null>(sql`null::text`, "gk"), gpass: as<number | null>(reconItems.breakPass, "gpass"), runId: as<string | null>(sql`null::uuid`, "run_id"),
    nA: as<number>(sql`(case when ${reconItems.side} = 'a' then 1 else 0 end)`, "n_a"), nB: as<number>(sql`(case when ${reconItems.side} = 'b' then 1 else 0 end)`, "n_b"),
    res: as<Resolution | null>(reconItems.resolution, "res_row"), ist: as<ItemStatus | null>(reconItems.status, "ist_row"), itemSide: as<string | null>(reconItems.side, "item_side"),
    proposed: as<boolean>(sql`${reconItems.proposedItemId} is not null`, "proposed_row"),
    openable: as<boolean>(sql`(${reconItems.status} = 'break' or ${reconItems.breakReason} is not null)`, "openable"),
    ...(withRecords ? {
      amountA: as<string>(sql`(case when ${reconItems.side} = 'a' then coalesce(${signed}, 0) else 0 end)::text`, "amount_a"),
      refSort: as<string | null>(records.extRef, "ref_sort"),
    } : {}),
  }).from(reconItems).$dynamic();
  const lone = (withRecords ? loneBase.leftJoin(records, recordOf) : loneBase)
    .where(and(live, gte(reconItems.businessDate, from), lte(reconItems.businessDate, to), notExists(inLiveGroup(tx, spaceId, reconItems.id)),
      hits ? inArray(reconItems.id, hits) : undefined));
  const u = groups.unionAll(lone).as("u");

  // the rows holding an item a pending request holds (its main item and the others of a force match)
  const pending = tx.select({ item: as<string>(sql`unnest(array_append(${approvalRequests.itemIds}, ${approvalRequests.itemId}))`, "p_item") }).from(approvalRequests)
    .where(and(eq(approvalRequests.spaceId, spaceId), eq(approvalRequests.configId, configId), eq(approvalRequests.status, "pending"))).as("p0");
  const pendingRows = tx.selectDistinct({ row: as<string>(rowOf(tx, spaceId, pending.item), "p_row") }).from(pending).as("p");
  // each row's latest posting run: the latest of its items'
  const lp = latestPostings(tx, spaceId, configId).as("lp");
  const byRow = tx.select({ row: as<string>(rowOf(tx, spaceId, lp.itemId), "rp_row"), st: as<string>(lp.st, "rp_st0"), bank: as<string | null>(lp.bank, "rp_bank0"), at: as<Date>(lp.at, "rp_at") })
    .from(lp).as("rp0");
  const rowPost = tx.selectDistinctOn([byRow.row], { row: byRow.row, st: as<PostingStatus>(byRow.st, "rp_st"), bank: as<string | null>(byRow.bank, "rp_bank") })
    .from(byRow).orderBy(byRow.row, desc(byRow.at)).as("rp");

  // the status table (resultStatus), first that holds
  // a lone item's own resolution, a group's from its resolved members
  const res = sql`coalesce(${u.res}, ${resolved.res})`;
  const pin = (vs: readonly string[]) => inList(rowPost.st, vs);
  const isPending = sql`(${pendingRows.row} is not null)`;
  const status = sql`case
    when ${pin(["failed", "timeout", "not_sent"])} then 'posting_failed'
    when ${pin(["queued", "sending", "grouped"])} then 'posting_in_progress'
    when ${res} = 'POSTED' and ${pin(["no_rule", "skipped"])} then 'posting_skipped'
    when ${isPending} then 'waiting_approval'
    when ${res} = 'POSTED' then 'posted'
    when ${res} = 'WRITTEN_OFF' then 'written_off'
    when ${res} = 'ADJUSTED' then 'adjusted'
    when ${res} in ('DUPLICATE', 'NO_ACTION') or ${u.ist} = 'closed' then 'closed'
    when ${u.gk} = 'force' or ${res} = 'FORCE_MATCHED' then 'force_matched'
    when ${u.gk} = 'manual' or ${res} = 'MATCHED_MANUAL' then 'matched_by_hand'
    when ${res} = 'AUTO_MATCHED_LATE_DATA' then 'matched_late'
    when ${u.gk} = 'suggested' or ${u.ist} = 'suggested' or (${u.ist} = 'break' and ${u.proposed}) then 'suggested'
    when ${u.gk} = 'auto' or ${u.ist} = 'matched' then 'matched'
    when ${u.ist} = 'break' then 'unmatch'
    when ${u.ist} = 'not_required' then 'not_required'
    else 'waiting_counterpart' end`;
  const itemState = sql`case ${u.ist} when 'break' then (case when ${u.proposed} then 'suggested' else 'unmatch' end) when 'open' then 'open' when 'closed' then 'closed' when 'suggested' then 'suggested' when 'not_required' then 'not_required' else 'in_group' end`;
  const side = (s: "a" | "b") => sql`case when ${u.kind} = 'group' then (case when ${s === "a" ? u.nA : u.nB} > 0 then (case when ${u.gk} = 'suggested' then 'suggested' else 'in_group' end) else 'none' end)
    when ${u.itemSide} = ${s} then ${itemState} else 'none' end`;
  return tx.select({
    rowId: u.rowId, kind: u.kind, bd: as<string>(sql`${u.bd}::text`, "bd_text"), gk: u.gk, gpass: u.gpass, runId: u.runId, nA: u.nA, nB: u.nB, res: as<Resolution | null>(res, "res"), ist: u.ist,
    proposed: u.proposed, openable: u.openable, pending: as<boolean>(isPending, "pending"), posting: rowPost.st, bank: rowPost.bank,
    ...(withRecords ? { amountA: (u as unknown as { amountA: SQL }).amountA, refSort: (u as unknown as { refSort: SQL }).refSort } : {}),
    status: as<ResultStatus>(status, "status"), sa: as<SideState>(side("a"), "sa"), sb: as<SideState>(side("b"), "sb"),
  }).from(u).leftJoin(resolved, eq(resolved.groupId, u.rowId)).leftJoin(pendingRows, eq(pendingRows.row, u.rowId)).leftJoin(rowPost, eq(rowPost.row, u.rowId)).as("rows");
}

type Rows = ReturnType<typeof resultRows>;
const whereOf = (rows: Rows, q: Filter) => and(
  q.result?.length ? inArray(rows.status, q.result) : undefined,
  q.sideA?.length ? inArray(rows.sa, q.sideA) : undefined,
  q.sideB?.length ? inArray(rows.sb, q.sideB) : undefined,
);
const statusRank = (rows: Rows) => sql`case ${rows.status} ${sql.join(RESULT_STATUSES.map((s, i) => sql`when ${s} then ${i}`), sql` `)} end`;

/**
 * GET …/recons/{configId}/results/counts: rows per overall status under every filter but `result`, and per side state
 * under every filter but that side's (each at most COUNT_CAP). One read: rows per (status, side A, side B), summed here.
 */
export function resultCounts(ctx: Ctx, configId: string, q: Filter, now = new Date()): Promise<ResultCountsDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    await resultColumnsOf(tx, spaceId, configId);
    await roomToAggregate(tx);
    const rows = resultRows(tx, spaceId, configId, await recordSpaces(tx, spaceId), datesOf(q, now), q);
    const by = await tx.select({ st: rows.status, sa: rows.sa, sb: rows.sb, n: countN }).from(rows).groupBy(rows.status, rows.sa, rows.sb);
    const takes = (vs: readonly string[] | undefined, v: string) => !vs?.length || vs.includes(v);
    let capped = false;
    const sum = <K extends string>(keep: (r: (typeof by)[number]) => boolean, key: (r: (typeof by)[number]) => K) => {
      const out: Partial<Record<K, number>> = {};
      for (const r of by) if (keep(r)) out[key(r)] = (out[key(r)] ?? 0) + r.n;
      for (const k of Object.keys(out) as K[]) if (out[k]! > COUNT_CAP) { out[k] = COUNT_CAP; capped = true; }
      return out;
    };
    return {
      counts: sum((r) => takes(q.sideA, r.sa) && takes(q.sideB, r.sb), (r) => r.st),
      sideA: sum((r) => takes(q.result, r.st) && takes(q.sideB, r.sb), (r) => r.sa),
      sideB: sum((r) => takes(q.result, r.st) && takes(q.sideA, r.sa), (r) => r.sb),
      capped,
    };
  });
}

/**
 * The recon's result rows on business dates `dates` per overall status, with their records (side A + side B items):
 * the dashboard rollup's input (stats.ts), the same rows `resultCounts` counts with no filter.
 */
export async function statusTally(tx: InTx, spaceId: string, configId: string, dates: [string, string]): Promise<{ status: ResultStatus; rows: number; records: number }[]> {
  await roomToAggregate(tx);
  const rows = resultRows(tx, spaceId, configId, await recordSpaces(tx, spaceId), dates, {});
  return tx.select({ status: rows.status, rows: countN, records: sql<number>`sum(${rows.nA} + ${rows.nB})::int` }).from(rows).groupBy(rows.status);
}

/**
 * The rows of business date `date` with an overall status in `statuses` (the dashboard's Resolved: the rows the rollup
 * counts), each as the minutes from its resolved items' business date start (Asia/Jakarta) to their resolution
 * (`state_at`): one value per row, so the Resolved count and its median come from the same rows (I2). A row whose
 * resolved items carry no time is left out.
 */
export async function resolvedRowMinutes(tx: InTx, spaceId: string, configId: string, date: string, statuses: readonly ResultStatus[]): Promise<number[]> {
  await roomToAggregate(tx);
  const rows = resultRows(tx, spaceId, configId, await recordSpaces(tx, spaceId), [date, date], {});
  const hit = await tx.select({ id: rows.rowId, kind: rows.kind }).from(rows).where(inArray(rows.status, [...statuses]));
  const lone = hit.filter((r) => r.kind === "item").map((r) => r.id), grouped = hit.filter((r) => r.kind === "group").map((r) => r.id);
  // a member is never dated after its group
  const resolved = and(eq(reconItems.spaceId, spaceId), eq(reconItems.configId, configId), isNull(reconItems.simRunId), eq(reconItems.breakState, "resolved"), isNotNull(reconItems.stateAt), lte(reconItems.businessDate, date));
  const m = sql<number>`floor(extract(epoch from max(${reconItems.stateAt}) - (min(${reconItems.businessDate})::timestamp at time zone 'Asia/Jakarta')) / 60)::int`;
  const a = lone.length ? await tx.select({ m }).from(reconItems).where(and(resolved, inArray(reconItems.id, lone))).groupBy(reconItems.id) : [];
  const b = grouped.length ? await tx.select({ m }).from(reconItems).innerJoin(matchMembers, and(eq(matchMembers.spaceId, reconItems.spaceId), eq(matchMembers.itemId, reconItems.id)))
    .where(and(resolved, inArray(matchMembers.groupId, grouped))).groupBy(matchMembers.groupId) : [];
  return [...a, ...b].map((r) => r.m);
}

type Item = {
  id: string; rowId: string; side: "a" | "b"; status: ItemStatus; bd: string; reason: string | null; assigneeId: string | null; stateAt: Date | null; breakState: string | null; resolution: Resolution | null; breakPass: number | null;
  ref: string | null; amount: bigint | null; ccy: string | null; dir: string | null; acct: string | null; eventTime: Date | null; recordBd: string | null; attrs: Record<string, unknown> | null;
};

/** The items of `rows` (group members or the lone item) with their records, in reference order. */
async function itemsOfRows(tx: InTx, spaceId: string, configId: string, spaces: string[], groupIds: string[], itemIds: string[]): Promise<Item[]> {
  if (!groupIds.length && !itemIds.length) return [];
  const rowId = sql<string>`coalesce(${matchMembers.groupId}, ${reconItems.id})`;
  const rows = await tx.select({
    id: reconItems.id, rowId, side: reconItems.side, status: reconItems.status, bd: reconItems.businessDate, reason: reconItems.breakReason, assigneeId: reconItems.assigneeId,
    stateAt: reconItems.stateAt, breakState: reconItems.breakState, resolution: reconItems.resolution, breakPass: reconItems.breakPass, ref: records.extRef, amount: records.amountMinor, ccy: records.currency, dir: records.direction,
    acct: records.accountRef, eventTime: records.eventTime, recordBd: records.businessDate, attrs: records.attrs,
  }).from(reconItems)
    .leftJoin(matchMembers, and(eq(matchMembers.spaceId, reconItems.spaceId), eq(matchMembers.itemId, reconItems.id), groupIds.length ? inArray(matchMembers.groupId, groupIds) : sql`false`))
    .leftJoin(records, and(inArray(records.spaceId, spaces), eq(records.id, reconItems.recordId), eq(records.businessDate, reconItems.businessDate)))
    .where(and(eq(reconItems.spaceId, spaceId), eq(reconItems.configId, configId), isNull(reconItems.simRunId),
      or(isNotNull(matchMembers.groupId), itemIds.length ? inArray(reconItems.id, itemIds) : sql`false`)))
    .orderBy(asc(records.extRef), asc(reconItems.id));
  return rows.map((r) => ({ ...r, side: r.side as "a" | "b", status: r.status as ItemStatus, resolution: r.resolution as Resolution | null, attrs: (r.attrs ?? null) as Record<string, unknown> | null }));
}

const signedOf = (i: Item) => (i.amount === null ? null : DEBIT_CODES.includes((i.dir ?? "").trim().toUpperCase()) ? -i.amount : i.amount);
/** A source field of an item's record as text (`ext_ref`, `amount_minor`, `attrs.<name>` …). */
function fieldOf(i: Item, field: string): string | null {
  const t = (v: unknown) => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v));
  if (field.startsWith("attrs.")) return t(i.attrs?.[field.slice(6)]);
  return t(({ ext_ref: i.ref, account_ref: i.acct, amount_minor: i.amount, currency: i.ccy, direction: i.dir, event_time: i.eventTime, business_date: i.recordBd } as Record<string, unknown>)[field]);
}
/** The value when every one is the same, else how many differ; `nonNull` = only the items that have one count. */
function same(vs: (string | null)[], nonNull = false): ResultCell {
  const set = new Set(nonNull ? vs.filter((v) => v !== null) : vs);
  if (set.size === 0) return { value: null, many: null };
  return set.size === 1 ? { value: [...set][0]!, many: null } : { value: null, many: set.size };
}
/** A side's amounts: their signed sum in its currency, "Mixed" over currencies (a record without one adds none). */
function amountCell(side: Item[]): ResultCell {
  const ccys = new Set(side.flatMap((i) => (i.ccy === null ? [] : [i.ccy])));
  if (ccys.size > 1) return { value: "Mixed", many: null, currency: null };
  const vs = side.map(signedOf).filter((v): v is bigint => v !== null);
  return { value: vs.length ? String(vs.reduce((a, b) => a + b, 0n)) : null, many: null, currency: [...ccys][0] ?? null };
}

/** GET …/recons/{configId}/results: one page of the recon's results, newest business date first unless `sort` says otherwise. */
export function resultPage(ctx: Ctx, configId: string, q: ResultListQuery, now = new Date()): Promise<Page<ResultRowDto>> {
  return inSpace(ctx, async (tx, spaceId) => {
    const cols = await resultColumnsOf(tx, spaceId, configId);
    const spaces = await recordSpaces(tx, spaceId);
    await roomToAggregate(tx);
    const rows = resultRows(tx, spaceId, configId, spaces, datesOf(q, now), q);
    const where = whereOf(rows, q);
    const extra = rows as unknown as { amountA?: SQL; refSort?: SQL };
    const page = await pageQuery({
      rows: tx.select().from(rows).where(where).$dynamic(),
      count: tx.select(one).from(rows).where(where).$dynamic(),
      orderBy: sortSql(q.sort, { businessDate: sql`${rows.bd}`, status: statusRank(rows), amountA: sql`(${extra.amountA ?? sql`0`})::numeric`, ref: sql`${extra.refSort ?? rows.rowId}` }, "-businessDate", sql`${rows.rowId}`),
      query: q, map: (r) => r, on: tx,
    });
    return { ...page, items: await fill(tx, spaceId, configId, spaces, cols, page.items) };
  });
}

/**
 * The report generator's read (DEC-060): result rows of `from`..`to` in (business date, row id) order after `after`
 * (keyset, so a row changed between two pages is read once), at most `limit`, with cells for `columns` (the report's,
 * not the recon's Results columns) and the recon's columns marked as customer data. Live rows only, like resultPage.
 */
export async function reportResultRows(
  tx: InTx, spaceId: string, configId: string, [from, to]: [string, string], o: { statuses: readonly ResultStatus[]; columns: ResultColumn[] },
  after: { bd: string; rowId: string } | null, limit: number,
): Promise<{ rows: ResultRowDto[]; last: { bd: string; rowId: string } | null; customer: Set<string> }> {
  const base = await resultColumnsOf(tx, spaceId, configId);
  const spaces = await recordSpaces(tx, spaceId);
  await roomToAggregate(tx);
  const rows = resultRows(tx, spaceId, configId, spaces, [from, to], {});
  const where = and(
    o.statuses.length ? inArray(rows.status, [...o.statuses]) : undefined,
    after ? sql`(${rows.bd}::date, ${rows.rowId}::uuid) > (${after.bd}::date, ${after.rowId}::uuid)` : undefined,
  );
  const page = await tx.select().from(rows).where(where).orderBy(asc(rows.bd), asc(rows.rowId)).limit(limit);
  const filled = await fill(tx, spaceId, configId, spaces, { ...base, columns: o.columns }, page);
  const lastRow = page.at(-1);
  const customer = new Set(base.columns.filter((c) => c.kind !== "recon" && c.customer).map((c) => `${c.kind}:${c.field}`));
  return { rows: filled, last: lastRow ? { bd: lastRow.bd, rowId: lastRow.rowId } : null, customer };
}

type RowOf = { rowId: string; kind: "group" | "item"; bd: string; gk: string | null; gpass: number | null; runId: string | null; nA: number; nB: number;
  res: Resolution | null; ist: ItemStatus | null; proposed: boolean; openable: boolean; pending: boolean; posting: PostingStatus | null; bank: string | null; sa: SideState; sb: SideState };

/** The page's rows with their cells (the recon's columns) and the TypeScript status. */
async function fill(tx: InTx, spaceId: string, configId: string, spaces: string[], cols: ResultColumnsOf, rows: RowOf[]): Promise<ResultRowDto[]> {
  const groupIds = rows.filter((r) => r.kind === "group").map((r) => r.rowId);
  const items = await itemsOfRows(tx, spaceId, configId, spaces, groupIds, rows.filter((r) => r.kind === "item").map((r) => r.rowId));
  const byRow = Map.groupBy(items, (i) => i.rowId);
  const reads = new Set(cols.columns.filter((c) => c.kind === "recon").map((c) => c.field));
  const assignees = reads.has("assignee") ? [...new Set(items.flatMap((i) => (i.assigneeId ? [i.assigneeId] : [])))] : [];
  const names = new Map(assignees.length ? (await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, assignees))).map((u) => [u.id, u.name]) : []);
  // a resolution's note: a person's match keeps it on its group; a decided request on the request (the latest approved per item)
  const groupNotes = new Map(reads.has("resolutionNote") && groupIds.length
    ? (await tx.select({ id: matchGroups.id, note: sql<string | null>`${matchGroups.evidence}->>'note'` }).from(matchGroups).where(and(eq(matchGroups.spaceId, spaceId), inArray(matchGroups.id, groupIds)))).map((g) => [g.id, g.note])
    : []);
  // each item's latest posting run (the status's input, per item)
  const postings = new Map<string, { st: string; bank: string | null }>();
  if ((reads.has("postingStatus") || reads.has("bankReference")) && items.length) {
    for (const p of await latestPostings(tx, spaceId, configId, items.map((i) => i.id))) postings.set(p.itemId, p);
  }
  const reqNotes = new Map<string, string>();
  if (reads.has("resolutionNote") && items.length) {
    const rq = await tx.selectDistinctOn([approvalRequests.itemId], { itemId: approvalRequests.itemId, note: approvalRequests.note }).from(approvalRequests)
      .where(and(eq(approvalRequests.spaceId, spaceId), eq(approvalRequests.status, "approved"), inArray(approvalRequests.itemId, items.map((i) => i.id))))
      .orderBy(approvalRequests.itemId, desc(approvalRequests.decidedAt));
    for (const r of rq) reqNotes.set(r.itemId, r.note);
  }
  return rows.map((r) => {
    const its = byRow.get(r.rowId) ?? [];
    const cells: Record<string, ResultCell> = {};
    for (const c of cols.columns) cells[`${c.kind}:${c.field}`] = cellOf(c, r, its, cols, names, groupNotes.get(r.rowId) ?? null, reqNotes, postings);
    return {
      id: r.rowId, kind: r.kind, businessDate: r.bd,
      status: resultStatus({ groupKind: r.gk as GroupKind | null, resolution: r.res, itemStatus: r.ist, proposed: r.proposed, pendingRequest: r.pending, posting: r.posting }),
      a: { state: r.sa, count: r.nA }, b: { state: r.sb, count: r.nB }, cells,
      openItemId: r.kind === "item" && r.openable ? r.rowId : null,
      explain: r.kind === "group" ? { groupId: r.rowId, itemId: null, runId: r.runId } : { groupId: null, itemId: r.rowId, runId: null },
    };
  });
}

function cellOf(c: ResultColumn, r: RowOf, its: Item[], cols: ResultColumnsOf, names: Map<string, string>, groupNote: string | null, reqNotes: Map<string, string>,
  postings: Map<string, { st: string; bank: string | null }>): ResultCell {
  if (c.kind !== "recon") {
    if (cols.fields?.[c.kind] && !cols.fields[c.kind]!.has(c.field)) return { value: null, many: null, missing: true };
    const side = its.filter((i) => i.side === c.kind);
    if (!side.length) return { value: null, many: null };
    return c.field === "amount_minor" ? amountCell(side) : same(side.map((i) => fieldOf(i, c.field)));
  }
  // recon info over the row's items, the ones that have a value: that value when they agree, else how many differ
  switch (c.field) {
    case "businessDate": return { value: r.bd, many: null };
    case "pass": return { value: r.gpass ? String(r.gpass) : null, many: null };
    case "reason": return same(its.map((i) => i.reason), true);
    case "assignee": return same(its.map((i) => (i.assigneeId ? names.get(i.assigneeId) ?? null : null)), true);
    case "postingStatus": return same(its.map((i) => postings.get(i.id)?.st ?? null), true);
    case "bankReference": return same(its.map((i) => postings.get(i.id)?.bank ?? null), true);
    case "resolutionNote": return groupNote ? { value: groupNote, many: null } : same(its.map((i) => reqNotes.get(i.id) ?? null), true);
    case "resolvedAt": return same(its.map((i) => (i.breakState === "resolved" && i.stateAt ? i.stateAt.toISOString() : null)), true);
  }
}

/** The core fields in the order Explain lists them (the ones people compare first), before a side's attributes. */
const EXPLAIN_ORDER: (keyof typeof FIELD_LABEL)[] = ["ext_ref", "amount_minor", "currency", "business_date", "event_time", "account_ref", "direction"];
/** An attribute as people read it: "settlement_ref" → "Settlement ref". */
const attrLabel = (name: string) => name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
/** A side's fields with their labels: those its source writes (known), else every core field and the attributes its records hold; attributes by label. */
function labelsOf(known: Set<string> | null, side: Item[]): ResultFieldDto[] {
  const keys = known ?? new Set([...EXPLAIN_ORDER, ...side.flatMap((i) => Object.keys(i.attrs ?? {}).map((k) => `attrs.${k}`))]);
  const core = EXPLAIN_ORDER.filter((k) => keys.has(k)).map((k) => ({ key: k, label: FIELD_LABEL[k] }));
  const attrs = [...keys].filter((k) => k.startsWith("attrs.")).map((k) => ({ key: k, label: attrLabel(k.slice(6)) })).sort((x, y) => x.label.localeCompare(y.label));
  return [...core, ...attrs];
}

/**
 * GET …/results/{rowId}/members: each side's records of a live group of the recon (`kind` group) or of an item no live
 * group holds (`kind` item), at most RESULT_MEMBERS_MAX per side, with every field of each (`values`, labelled per side
 * in `labels`) and the recon's side columns; and the row's recon data (`summary`); else 404.
 */
export function resultMembers(ctx: Ctx, configId: string, rowId: string, q: ResultMembersQuery): Promise<ResultMembersDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const cols = await resultColumnsOf(tx, spaceId, configId);
    let group: { kind: string; pass: number } | null = null;
    if (q.kind === "group") {
      const [g] = await tx.select({ kind: matchGroups.kind, pass: matchGroups.passNo }).from(matchGroups).where(and(eq(matchGroups.spaceId, spaceId), eq(matchGroups.configId, configId), eq(matchGroups.id, rowId), isNull(matchGroups.reversedBy), isNull(matchGroups.simRunId)));
      if (!g) throw notFound("result");
      group = g;
    } else {
      const [i] = await tx.select(one).from(reconItems).where(and(eq(reconItems.spaceId, spaceId), eq(reconItems.configId, configId), eq(reconItems.id, rowId), isNull(reconItems.simRunId), notExists(inLiveGroup(tx, spaceId, reconItems.id))));
      if (!i) throw notFound("result");
    }
    // ponytail: every member is read, then cut at RESULT_MEMBERS_MAX a side; a limited read per side if groups grow past thousands
    const items = await itemsOfRows(tx, spaceId, configId, await recordSpaces(tx, spaceId), q.kind === "group" ? [rowId] : [], q.kind === "item" ? [rowId] : []);
    const of = (s: "a" | "b") => items.filter((i) => i.side === s);
    const labels = { a: labelsOf(cols.fields?.a ?? null, of("a")), b: labelsOf(cols.fields?.b ?? null, of("b")) };
    const member = (i: Item): ResultMemberDto => ({
      id: i.id, businessDate: i.bd, status: i.status, ref: i.ref, amountMinor: i.amount === null ? null : String(signedOf(i)), currency: i.ccy,
      fields: Object.fromEntries(cols.columns.filter((c) => c.kind === i.side).map((c) => [`${c.kind}:${c.field}`, fieldOf(i, c.field)])),
      values: Object.fromEntries(labels[i.side].map((f) => [f.key, f.key === "amount_minor" ? (i.amount === null ? null : String(signedOf(i))) : fieldOf(i, f.key)])),
    });
    const ids = items.map((i) => i.id);
    const assignees = [...new Set(items.flatMap((i) => (i.assigneeId ? [i.assigneeId] : [])))];
    const names = new Map(assignees.length ? (await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, assignees))).map((u) => [u.id, u.name]) : []);
    // the latest request holding one of the row's items (its main item or one of `item_ids`)
    const [rq] = ids.length ? await tx.select({ kind: approvalRequests.kind, status: approvalRequests.status, itemId: approvalRequests.itemId }).from(approvalRequests)
      .where(and(eq(approvalRequests.spaceId, spaceId), eq(approvalRequests.configId, configId),
        or(inArray(approvalRequests.itemId, ids), sql`${approvalRequests.itemIds} && array[${sql.join(ids.map((x) => sql`${x}`), sql`, `)}]::uuid[]`)))
      .orderBy(desc(approvalRequests.requestedAt)).limit(1) : [];
    const runs = ids.length ? await latestPostings(tx, spaceId, configId, ids) : [];
    // the item its actions go through, as its Unmatch item page (breakOf): a lone item that is or was a break; in a
    // group, the item a waiting request holds, else one that broke (yours first), else side A's first
    const broke = items.filter((i) => i.reason !== null);
    const workItemId = q.kind === "item" ? (items[0] && (items[0].status === "break" || items[0].reason !== null) ? items[0].id : null)
      : (rq?.status === "pending" && ids.includes(rq.itemId) ? rq.itemId : null) ?? (broke.find((i) => i.assigneeId === ctx.user.id) ?? broke[0] ?? of("a")[0] ?? items[0])?.id ?? null;
    return {
      a: of("a").slice(0, RESULT_MEMBERS_MAX).map(member), b: of("b").slice(0, RESULT_MEMBERS_MAX).map(member),
      more: { a: Math.max(0, of("a").length - RESULT_MEMBERS_MAX), b: Math.max(0, of("b").length - RESULT_MEMBERS_MAX) },
      labels,
      summary: {
        groupKind: (group?.kind ?? null) as GroupKind | null, pass: group ? group.pass : (items[0]?.breakPass ?? null),
        resolution: RES_ORDER.find((r) => items.some((i) => i.resolution === r)) ?? null,
        reason: same(items.map((i) => i.reason), true), assignee: same(items.map((i) => (i.assigneeId ? names.get(i.assigneeId) ?? null : null)), true),
        request: rq ? { kind: rq.kind as RequestKind, status: rq.status as "pending" | "approved" | "rejected" | "cancelled" } : null,
        posting: runs.length ? { status: same(runs.map((p) => p.st), true), bankReference: same(runs.map((p) => p.bank), true) } : null,
        workItemId,
      },
    };
  });
}

