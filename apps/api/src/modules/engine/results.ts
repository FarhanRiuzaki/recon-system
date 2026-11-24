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
import type { ResultCell, ResultColumn, ResultCountsDto, ResultListQuery, ResultMemberDto, ResultMembersDto, ResultMembersQuery, ResultRowDto } from "@starterkit/shared/contracts/results";
import type { GroupKind, ItemStatus, Resolution } from "@starterkit/shared/recon";
import { RESULT_MEMBERS_MAX, RESULT_STATUSES, type PostingStatus, type ResultStatus, resultStatus, type SideState } from "@starterkit/shared/results";
import { DEBIT_CODES } from "@starterkit/shared/sources";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, notExists, or, type SQL, sql } from "drizzle-orm";
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
 * Every result row of the range with its status inputs, aggregated per row (`rows`): one select per row kind (groups
 * with their members' items, lone items) joined to the pending requests and latest posting runs. `withRecords` joins
 * each item's record (the reference search and the sorts by amount A and reference read it).
 */
function resultRows(tx: InTx, spaceId: string, configId: string, spaces: string[], [from, to]: [string, string], q: Filter) {
  const live = and(eq(reconItems.spaceId, spaceId), eq(reconItems.configId, configId), isNull(reconItems.simRunId));
  const itemCols = {
    itemId: as<string>(reconItems.id, "item_id"), side: as<string>(reconItems.side, "side"), ist: as<string>(reconItems.status, "ist"),
    res: as<string | null>(reconItems.resolution, "res"), proposed: as<boolean>(sql`${reconItems.proposedItemId} is not null`, "proposed"),
    broke: as<boolean>(sql`(${reconItems.status} = 'break' or ${reconItems.breakReason} is not null)`, "broke"),
    recordId: as<string>(reconItems.recordId, "record_id"), itemBd: as<string>(reconItems.businessDate, "item_bd"),
  };
  const groups = tx.select({
    rowId: as<string>(matchGroups.id, "row_id"), kind: as<"group" | "item">(sql`'group'`, "kind"), bd: as<string>(matchGroups.businessDate, "bd"),
    gk: as<string | null>(matchGroups.kind, "gk"), gpass: as<number | null>(matchGroups.passNo, "gpass"), runId: as<string | null>(matchGroups.runId, "run_id"), ...itemCols,
  }).from(matchGroups)
    .innerJoin(matchMembers, and(eq(matchMembers.spaceId, matchGroups.spaceId), eq(matchMembers.groupId, matchGroups.id)))
    // a member is never dated after its group (the group's date is the latest of its members'): prunes later partitions
    .innerJoin(reconItems, and(live, eq(reconItems.id, matchMembers.itemId), lte(reconItems.businessDate, matchGroups.businessDate)))
    .where(and(eq(matchGroups.spaceId, spaceId), eq(matchGroups.configId, configId), isNull(matchGroups.simRunId), isNull(matchGroups.reversedBy),
      gte(matchGroups.businessDate, from), lte(matchGroups.businessDate, to)));
  const lone = tx.select({
    rowId: as<string>(reconItems.id, "row_id"), kind: as<"group" | "item">(sql`'item'`, "kind"), bd: as<string>(reconItems.businessDate, "bd"),
    gk: as<string | null>(sql`null::text`, "gk"), gpass: as<number | null>(reconItems.breakPass, "gpass"), runId: as<string | null>(sql`null::uuid`, "run_id"), ...itemCols,
  }).from(reconItems)
    .where(and(live, gte(reconItems.businessDate, from), lte(reconItems.businessDate, to), notExists(inLiveGroup(tx, spaceId, reconItems.id))));
  const ri = groups.unionAll(lone).as("ri");

  // the items a pending request holds: its main item and the others of a force match
  const pending = tx.selectDistinct({ itemId: as<string>(sql`unnest(array_append(${approvalRequests.itemIds}, ${approvalRequests.itemId}))`, "p_item") }).from(approvalRequests)
    .where(and(eq(approvalRequests.spaceId, spaceId), eq(approvalRequests.configId, configId), eq(approvalRequests.status, "pending"))).as("p");
  // posting runs per item: its own, and its posting groups' (open = grouped); the latest per item
  const run = alias(actionRuns, "grun");
  const own = tx.select({ itemId: as<string>(actionRuns.itemId, "r_item"), st: as<string>(actionRuns.status, "st"), at: as<Date>(actionRuns.createdAt, "at"), bank: as<string | null>(actionRuns.bankReference, "bank") })
    .from(actionRuns).where(and(eq(actionRuns.spaceId, spaceId), eq(actionRuns.kind, "posting"), isNotNull(actionRuns.itemId)));
  const grouped = tx.select({
    itemId: as<string>(postingGroupItems.itemId, "r_item"), st: as<string>(sql`case when ${postingGroups.status} = 'open' then 'grouped' else ${run.status} end`, "st"),
    at: as<Date>(sql`coalesce(${run.createdAt}, ${postingGroupItems.joinedAt})`, "at"), bank: as<string | null>(run.bankReference, "bank"),
  }).from(postingGroupItems)
    .innerJoin(postingGroups, eq(postingGroups.id, postingGroupItems.groupId))
    .leftJoin(run, and(eq(run.spaceId, postingGroups.spaceId), eq(run.id, postingGroups.runId)))
    .where(and(eq(postingGroupItems.spaceId, spaceId), eq(postingGroups.configId, configId), or(eq(postingGroups.status, "open"), isNotNull(run.id))));
  const runs = own.unionAll(grouped).as("pr");
  const latest = tx.selectDistinctOn([runs.itemId], { itemId: runs.itemId, st: runs.st, bank: runs.bank, at: runs.at }).from(runs).orderBy(runs.itemId, desc(runs.at)).as("lp");

  const withRecords = !!q.q?.trim() || /^-?(amountA|ref)$/.test(q.sort ?? "");
  const like = q.q?.trim() ? `%${likeEscape(q.q.trim())}%` : null;
  const signed = sql`case when upper(btrim(coalesce(${records.direction}, ''))) in (${sql.join(DEBIT_CODES.map(lit), sql`, `)}) then -${records.amountMinor} else ${records.amountMinor} end`;
  // the row's resolution: the first of its items' in the status table's order
  const RES_ORDER: Resolution[] = ["POSTED", "WRITTEN_OFF", "ADJUSTED", "DUPLICATE", "NO_ACTION", "FORCE_MATCHED", "MATCHED_MANUAL", "AUTO_MATCHED_LATE_DATA"];
  const res = sql`case ${sql.join(RES_ORDER.map((r) => sql`when bool_or(${ri.res} = ${r}) then ${r}`), sql` `)} end`;
  const isItem = sql`${ri.kind} = 'item'`;
  const base = tx.select({
    rowId: ri.rowId, kind: ri.kind, bd: ri.bd, gk: ri.gk, gpass: ri.gpass, runId: ri.runId,
    nA: as<number>(sql`(count(*) filter (where ${ri.side} = 'a'))::int`, "n_a"), nB: as<number>(sql`(count(*) filter (where ${ri.side} = 'b'))::int`, "n_b"),
    res: as<Resolution | null>(res, "res_row"),
    ist: as<ItemStatus | null>(sql`min(${ri.ist}) filter (where ${isItem})`, "ist_row"),
    itemSide: as<string | null>(sql`min(${ri.side}) filter (where ${isItem})`, "item_side"),
    proposed: as<boolean>(sql`coalesce(bool_or(${ri.proposed}) filter (where ${isItem}), false)`, "proposed_row"),
    openable: as<boolean>(sql`coalesce(bool_or(${ri.broke}) filter (where ${isItem}), false)`, "openable"),
    pending: as<boolean>(sql`bool_or(${pending.itemId} is not null)`, "pending"),
    posting: as<PostingStatus | null>(sql`(array_agg(${latest.st} order by ${latest.at} desc) filter (where ${latest.st} is not null))[1]`, "posting"),
    bank: as<string | null>(sql`(array_agg(${latest.bank} order by ${latest.at} desc) filter (where ${latest.st} is not null))[1]`, "bank_row"),
    ...(withRecords ? {
      amountA: as<string | null>(sql`coalesce(sum(${signed}) filter (where ${ri.side} = 'a'), 0)::text`, "amount_a"),
      refSort: as<string | null>(sql`coalesce(min(${records.extRef}) filter (where ${ri.side} = 'a'), min(${records.extRef}) filter (where ${ri.side} = 'b'))`, "ref_sort"),
    } : {}),
  }).from(ri)
    .leftJoin(pending, eq(pending.itemId, ri.itemId))
    .leftJoin(latest, eq(latest.itemId, ri.itemId)).$dynamic();
  const joined = withRecords ? base.leftJoin(records, and(inArray(records.spaceId, spaces), eq(records.id, ri.recordId), eq(records.businessDate, ri.itemBd))) : base;
  const agg = joined.groupBy(ri.rowId, ri.kind, ri.bd, ri.gk, ri.gpass, ri.runId)
    .having(like ? sql`bool_or(${records.extRef} ilike ${like})` : undefined).as("agg");

  // the status table (resultStatus), first that holds
  const pin = (vs: readonly string[]) => inList(agg.posting, vs);
  const status = sql`case
    when ${pin(["failed", "timeout", "not_sent"])} then 'posting_failed'
    when ${pin(["queued", "sending", "grouped"])} then 'posting_in_progress'
    when ${agg.res} = 'POSTED' and ${pin(["no_rule", "skipped"])} then 'posting_skipped'
    when ${agg.pending} then 'waiting_approval'
    when ${agg.res} = 'POSTED' then 'posted'
    when ${agg.res} = 'WRITTEN_OFF' then 'written_off'
    when ${agg.res} = 'ADJUSTED' then 'adjusted'
    when ${agg.res} in ('DUPLICATE', 'NO_ACTION') or ${agg.ist} = 'closed' then 'closed'
    when ${agg.gk} = 'force' or ${agg.res} = 'FORCE_MATCHED' then 'force_matched'
    when ${agg.gk} = 'manual' or ${agg.res} = 'MATCHED_MANUAL' then 'matched_by_hand'
    when ${agg.res} = 'AUTO_MATCHED_LATE_DATA' then 'matched_late'
    when ${agg.gk} = 'suggested' or ${agg.ist} = 'suggested' or (${agg.ist} = 'break' and ${agg.proposed}) then 'suggested'
    when ${agg.gk} = 'auto' or ${agg.ist} = 'matched' then 'matched'
    when ${agg.ist} = 'break' then 'unmatch'
    else 'waiting_counterpart' end`;
  const itemState = sql`case ${agg.ist} when 'break' then (case when ${agg.proposed} then 'suggested' else 'unmatch' end) when 'open' then 'open' when 'closed' then 'closed' when 'suggested' then 'suggested' else 'in_group' end`;
  const side = (s: "a" | "b") => sql`case when ${agg.kind} = 'group' then (case when ${s === "a" ? agg.nA : agg.nB} > 0 then (case when ${agg.gk} = 'suggested' then 'suggested' else 'in_group' end) else 'none' end)
    when ${agg.itemSide} = ${s} then ${itemState} else 'none' end`;
  return tx.select({
    rowId: agg.rowId, kind: agg.kind, bd: as<string>(sql`${agg.bd}::text`, "bd_text"), gk: agg.gk, gpass: agg.gpass, runId: agg.runId, nA: agg.nA, nB: agg.nB, res: agg.res, ist: agg.ist,
    proposed: agg.proposed, openable: agg.openable, pending: agg.pending, posting: agg.posting, bank: agg.bank,
    ...(withRecords ? { amountA: (agg as unknown as { amountA: SQL }).amountA, refSort: (agg as unknown as { refSort: SQL }).refSort } : {}),
    status: as<ResultStatus>(status, "status"), sa: as<SideState>(side("a"), "sa"), sb: as<SideState>(side("b"), "sb"),
  }).from(agg).as("rows");
}

type Rows = ReturnType<typeof resultRows>;
const whereOf = (rows: Rows, q: Filter, withResult: boolean) => and(
  withResult && q.result?.length ? inArray(rows.status, q.result) : undefined,
  q.sideA?.length ? inArray(rows.sa, q.sideA) : undefined,
  q.sideB?.length ? inArray(rows.sb, q.sideB) : undefined,
);
const statusRank = (rows: Rows) => sql`case ${rows.status} ${sql.join(RESULT_STATUSES.map((s, i) => sql`when ${s} then ${i}`), sql` `)} end`;

/** GET …/recons/{configId}/results/counts: rows per overall status under every filter but `result` (each at most COUNT_CAP). */
export function resultCounts(ctx: Ctx, configId: string, q: Filter, now = new Date()): Promise<ResultCountsDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    await resultColumnsOf(tx, spaceId, configId);
    const rows = resultRows(tx, spaceId, configId, await recordSpaces(tx, spaceId), datesOf(q, now), q);
    const by = await tx.select({ st: rows.status, n: countN }).from(rows).where(whereOf(rows, q, false)).groupBy(rows.status);
    return { counts: Object.fromEntries(by.map((r) => [r.st, Math.min(r.n, COUNT_CAP)])) as ResultCountsDto["counts"], capped: by.some((r) => r.n > COUNT_CAP) };
  });
}

type Item = {
  id: string; rowId: string; side: "a" | "b"; status: ItemStatus; bd: string; reason: string | null; assigneeId: string | null; stateAt: Date | null; breakState: string | null;
  ref: string | null; amount: bigint | null; ccy: string | null; dir: string | null; acct: string | null; eventTime: Date | null; recordBd: string | null; attrs: Record<string, unknown> | null;
};

/** The items of `rows` (group members or the lone item) with their records, in reference order. */
async function itemsOfRows(tx: InTx, spaceId: string, configId: string, spaces: string[], groupIds: string[], itemIds: string[]): Promise<Item[]> {
  if (!groupIds.length && !itemIds.length) return [];
  const rowId = sql<string>`coalesce(${matchMembers.groupId}, ${reconItems.id})`;
  const rows = await tx.select({
    id: reconItems.id, rowId, side: reconItems.side, status: reconItems.status, bd: reconItems.businessDate, reason: reconItems.breakReason, assigneeId: reconItems.assigneeId,
    stateAt: reconItems.stateAt, breakState: reconItems.breakState, ref: records.extRef, amount: records.amountMinor, ccy: records.currency, dir: records.direction,
    acct: records.accountRef, eventTime: records.eventTime, recordBd: records.businessDate, attrs: records.attrs,
  }).from(reconItems)
    .leftJoin(matchMembers, and(eq(matchMembers.spaceId, reconItems.spaceId), eq(matchMembers.itemId, reconItems.id), groupIds.length ? inArray(matchMembers.groupId, groupIds) : sql`false`))
    .leftJoin(records, and(inArray(records.spaceId, spaces), eq(records.id, reconItems.recordId), eq(records.businessDate, reconItems.businessDate)))
    .where(and(eq(reconItems.spaceId, spaceId), eq(reconItems.configId, configId), isNull(reconItems.simRunId),
      or(isNotNull(matchMembers.groupId), itemIds.length ? inArray(reconItems.id, itemIds) : sql`false`)))
    .orderBy(asc(records.extRef), asc(reconItems.id));
  return rows.map((r) => ({ ...r, side: r.side as "a" | "b", status: r.status as ItemStatus, attrs: (r.attrs ?? null) as Record<string, unknown> | null }));
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
/** A side's amounts: their signed sum in its currency, "Mixed" over currencies. */
function amountCell(side: Item[]): ResultCell {
  const ccys = new Set(side.map((i) => i.ccy));
  if (ccys.size > 1) return { value: "Mixed", many: null, currency: null };
  const vs = side.map(signedOf).filter((v): v is bigint => v !== null);
  return { value: vs.length ? String(vs.reduce((a, b) => a + b, 0n)) : null, many: null, currency: [...ccys][0] ?? null };
}

/** GET …/recons/{configId}/results: one page of the recon's results, by business date unless `sort` says otherwise. */
export function resultPage(ctx: Ctx, configId: string, q: ResultListQuery, now = new Date()): Promise<Page<ResultRowDto>> {
  return inSpace(ctx, async (tx, spaceId) => {
    const cols = await resultColumnsOf(tx, spaceId, configId);
    const spaces = await recordSpaces(tx, spaceId);
    const rows = resultRows(tx, spaceId, configId, spaces, datesOf(q, now), q);
    const where = whereOf(rows, q, true);
    const extra = rows as unknown as { amountA?: SQL; refSort?: SQL };
    const page = await pageQuery({
      rows: tx.select().from(rows).where(where).$dynamic(),
      count: tx.select(one).from(rows).where(where).$dynamic(),
      orderBy: sortSql(q.sort, { businessDate: sql`${rows.bd}`, status: statusRank(rows), amountA: sql`(${extra.amountA ?? sql`0`})::numeric`, ref: sql`${extra.refSort ?? rows.rowId}` }, "businessDate", sql`${rows.rowId}`),
      query: q, map: (r) => r, on: tx,
    });
    return { ...page, items: await fill(tx, spaceId, configId, spaces, cols, page.items) };
  });
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
    for (const c of cols.columns) cells[`${c.kind}:${c.field}`] = cellOf(c, r, its, cols, names, groupNotes.get(r.rowId) ?? null, reqNotes);
    return {
      id: r.rowId, kind: r.kind, businessDate: r.bd,
      status: resultStatus({ groupKind: r.gk as GroupKind | null, resolution: r.res, itemStatus: r.ist, proposed: r.proposed, pendingRequest: r.pending, posting: r.posting }),
      a: { state: r.sa, count: r.nA }, b: { state: r.sb, count: r.nB }, cells,
      openItemId: r.kind === "item" && r.openable ? r.rowId : null,
      explain: r.kind === "group" ? { groupId: r.rowId, itemId: null, runId: r.runId } : { groupId: null, itemId: r.rowId, runId: null },
    };
  });
}

function cellOf(c: ResultColumn, r: RowOf, its: Item[], cols: ResultColumnsOf, names: Map<string, string>, groupNote: string | null, reqNotes: Map<string, string>): ResultCell {
  if (c.kind !== "recon") {
    if (cols.fields && !cols.fields[c.kind].has(c.field)) return { value: null, many: null, missing: true };
    const side = its.filter((i) => i.side === c.kind);
    if (!side.length) return { value: null, many: null };
    return c.field === "amount_minor" ? amountCell(side) : same(side.map((i) => fieldOf(i, c.field)));
  }
  // recon info over the row's items: the ones that have a value
  switch (c.field) {
    case "businessDate": return { value: r.bd, many: null };
    case "pass": return { value: r.gpass ? String(r.gpass) : null, many: null };
    case "reason": return same(its.map((i) => i.reason), true);
    case "assignee": return same(its.map((i) => (i.assigneeId ? names.get(i.assigneeId) ?? null : null)), true);
    case "postingStatus": return { value: r.posting, many: null };
    case "bankReference": return { value: r.bank, many: null };
    case "resolutionNote": return groupNote ? { value: groupNote, many: null } : same(its.map((i) => reqNotes.get(i.id) ?? null), true);
    case "resolvedAt": {
      const at = its.filter((i) => i.breakState === "resolved" && i.stateAt).map((i) => i.stateAt!.getTime());
      return { value: at.length ? new Date(Math.max(...at)).toISOString() : null, many: null };
    }
  }
}

/**
 * GET …/results/{rowId}/members: each side's records of a live group of the recon (`kind` group) or of an item no live
 * group holds (`kind` item), at most RESULT_MEMBERS_MAX per side, with the recon's side columns; else 404.
 */
export function resultMembers(ctx: Ctx, configId: string, rowId: string, q: ResultMembersQuery): Promise<ResultMembersDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const cols = await resultColumnsOf(tx, spaceId, configId);
    if (q.kind === "group") {
      const [g] = await tx.select(one).from(matchGroups).where(and(eq(matchGroups.spaceId, spaceId), eq(matchGroups.configId, configId), eq(matchGroups.id, rowId), isNull(matchGroups.reversedBy), isNull(matchGroups.simRunId)));
      if (!g) throw notFound("result");
    } else {
      const [i] = await tx.select(one).from(reconItems).where(and(eq(reconItems.spaceId, spaceId), eq(reconItems.configId, configId), eq(reconItems.id, rowId), isNull(reconItems.simRunId), notExists(inLiveGroup(tx, spaceId, reconItems.id))));
      if (!i) throw notFound("result");
    }
    // ponytail: every member is read, then cut at RESULT_MEMBERS_MAX a side; a limited read per side if groups grow past thousands
    const items = await itemsOfRows(tx, spaceId, configId, await recordSpaces(tx, spaceId), q.kind === "group" ? [rowId] : [], q.kind === "item" ? [rowId] : []);
    const member = (i: Item): ResultMemberDto => ({
      id: i.id, businessDate: i.bd, status: i.status, ref: i.ref, amountMinor: i.amount === null ? null : String(i.amount), currency: i.ccy,
      fields: Object.fromEntries(cols.columns.filter((c) => c.kind === i.side).map((c) => [`${c.kind}:${c.field}`, fieldOf(i, c.field)])),
    });
    const of = (s: "a" | "b") => items.filter((i) => i.side === s);
    return {
      a: of("a").slice(0, RESULT_MEMBERS_MAX).map(member), b: of("b").slice(0, RESULT_MEMBERS_MAX).map(member),
      more: { a: Math.max(0, of("a").length - RESULT_MEMBERS_MAX), b: Math.max(0, of("b").length - RESULT_MEMBERS_MAX) },
    };
  });
}
