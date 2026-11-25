// Intake (spec §9 run tick, step 2): the current records of a side's source in the window that pass the side's filters
// become open items of the config, once per (config, record) (live) or per (simulation, record): a step sent again adds
// nothing. Reads `records` only (the engine never writes it, so source_day_counts stays the ingest's alone).
import type { Filter } from "@starterkit/shared/contracts/recon";
import { type SQL, sql } from "drizzle-orm";
import { records } from "../../ingest";
import { matchGroups, matchMembers, reconItems } from "../schema";
import { datesOf, filterSql, type StepCtx } from "./pass";

/**
 * One chunk of side `s`'s intake of business date `date`: its records with seq past `after` (records.seq), at most
 * `limit` in seq order (the index records_source_seq), and of those the current ones that pass the side's filters and
 * have no item yet become open items. Answers the items inserted (`n`), the records read (`scanned`; fewer than `limit`
 * = the date is read through) and the last seq read (`last`, null when none): the next chunk, and a live intake's mark,
 * goes on from there, so a tick reads what arrived since, never the day again (REC-P1). A record with an item already
 * is skipped by NOT EXISTS, not by ON CONFLICT: that would wait on an item an operator holds (A1).
 */
export function intakeSql(c: StepCtx, s: 0 | 1, filters: readonly Filter[], date: string, after: number, limit: number): SQL {
  const side = c.sides[s];
  const ok = [c.current, ...filters.map((f) => filterSql(side, f))];
  return sql`with cand as materialized (select ${records.id} as id, ${records.businessDate} as bd, ${records.seq} as seq, (${sql.join(ok, sql` and `)}) as ok
      from ${records} where ${records.spaceId} = ${side.sourceSpaceId} and ${records.sourceId} = ${side.sourceId} and ${records.businessDate} = ${date}::date
        and ${records.seq} > ${after} order by ${records.seq} limit ${limit}),
  ins as (insert into ${reconItems} (id, space_id, config_id, record_id, side, business_date, sim_run_id)
    select uuidv7(), ${c.spaceId}::uuid, ${c.configId}::uuid, cand.id, ${side.key}::text, cand.bd, ${c.simRunId}::uuid from cand
    where cand.ok and not exists (select 1 from ${reconItems} x where x.space_id = ${c.spaceId} and x.config_id = ${c.configId} and x.record_id = cand.id
        and x.business_date = cand.bd and ${c.simRunId === null ? sql`x.sim_run_id is null` : sql`x.sim_run_id = ${c.simRunId}`})
    on conflict do nothing returning 1)
  select (select count(*) from ins)::int as n, (select count(*) from cand)::int as scanned, (select max(seq) from cand)::text as last`;
}

/** Why the engine reverses a group: a member's record was replaced by its mutable source (spec §8, REC-FUT-15). */
export const SOURCE_CHANGED = "source_changed";

/**
 * Reverses the engine's groups (auto, suggested; not a person's manual or forced match) in the window that hold an item
 * of side `s` whose record no longer counts (a mutable source replaced the row, or its snapshot is no longer active):
 * the group gets reversed_by = this run, reverse_reason source_changed and reversed_at, and every member item goes back
 * to open (version + 1; a late-data break it had resolved is unresolved again), so the record's new version can pair again; the replaced member then closes
 * (closeReplacedSql). A group is reversed only when this statement locks all its items at the status and version read
 * (A1): one an operator holds waits for the next run. Answers { n } groups reversed.
 */
export function reverseReplacedSql(c: StepCtx, s: 0 | 1): SQL {
  const side = c.sides[s];
  const live = (a: string) => (c.simRunId === null ? sql.raw(`${a}.sim_run_id is null`) : sql`${sql.raw(a)}.sim_run_id = ${c.simRunId}`);
  return sql`with gone as materialized (select distinct m.group_id as id from ${reconItems} i
      join ${matchMembers} m on m.space_id = i.space_id and m.item_id = i.id
      join ${matchGroups} g on g.space_id = m.space_id and g.id = m.group_id
      where i.space_id = ${c.spaceId} and i.config_id = ${c.configId} and i.side = ${side.key} and i.status in ('matched', 'suggested')
        and ${live("i")} and i.business_date between ${c.lo}::date and ${c.hi}::date
        and g.reversed_by is null and g.kind in ('auto', 'suggested') and ${live("g")}
        and not exists (select 1 from ${records} where ${records.spaceId} = ${side.sourceSpaceId} and ${records.sourceId} = ${side.sourceId}
          and ${records.id} = i.record_id and ${records.businessDate} = i.business_date and ${c.current})),
  lk as materialized (select i.id, i.version as v, i.status as st, i.business_date as bd, m.group_id as gid from ${reconItems} i
      join ${matchMembers} m on m.space_id = i.space_id and m.item_id = i.id
      where m.space_id = ${c.spaceId} and m.group_id in (select id from gone) and i.config_id = ${c.configId} and i.status in ('matched', 'suggested')
      for update of i skip locked),
  whole as (select lk.gid from lk group by lk.gid
      having count(*) = (select count(*) from ${matchMembers} mm where mm.space_id = ${c.spaceId} and mm.group_id = lk.gid)),
  rg as (update ${matchGroups} g set reversed_by = ${c.runId}::uuid, reverse_reason = ${SOURCE_CHANGED}, reversed_at = now()
      where g.space_id = ${c.spaceId} and g.id in (select gid from whole) and g.reversed_by is null returning g.id),
  up as (update ${reconItems} i set status = 'open', resolution = null, version = i.version + 1,
      break_state = case when i.break_state = 'resolved' then null else i.break_state end
      from lk where i.space_id = ${c.spaceId} and i.id = lk.id and i.business_date = lk.bd and i.status = lk.st and i.version = lk.v
        and lk.gid in (select id from rg) returning i.business_date as bd)
  select (select count(*) from rg)::int as n, (select count(*) from up)::int as items, ${datesOf("up")}`;
}

/**
 * Closes side `s`'s open (and not_required, DEC-055) items of the window whose record no longer counts (a mutable source replaced the row, or its
 * snapshot is no longer active): status closed, reason "Source row replaced", so they never wait or count as open.
 * Only items this statement locks (A1). A matched or suggested group with a replaced record was reversed just before
 * (reverseReplacedSql), so its replaced member is open here and closes too.
 */
export function closeReplacedSql(c: StepCtx, s: 0 | 1): SQL {
  const side = c.sides[s];
  return sql`with t as (select i.id, i.version as v, i.business_date as bd from ${reconItems} i
      where i.space_id = ${c.spaceId} and i.config_id = ${c.configId} and i.side = ${side.key} and i.status in ('open', 'not_required')
        and ${c.simRunId === null ? sql`i.sim_run_id is null` : sql`i.sim_run_id = ${c.simRunId}`}
        and i.business_date between ${c.lo}::date and ${c.hi}::date
        and not exists (select 1 from ${records} where ${records.spaceId} = ${side.sourceSpaceId} and ${records.sourceId} = ${side.sourceId}
          and ${records.id} = i.record_id and ${records.businessDate} = i.business_date and ${c.current})
      for update of i skip locked),
  up as (update ${reconItems} i set status = 'closed', break_reason = ${REPLACED}, version = i.version + 1
      from t x where i.space_id = ${c.spaceId} and i.id = x.id and i.business_date = x.bd and i.status in ('open', 'not_required') and i.version = x.v returning i.business_date as bd)
  select (select count(*) from up)::int as n, ${datesOf("up")}`;
}
/** The reason an item closes when its record no longer counts. */
export const REPLACED = "Source row replaced";
