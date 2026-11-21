// Intake (spec §9 run tick, step 2): the current records of a side's source in the window that pass the side's filters
// become open items of the config, once per (config, record) (live) or per (simulation, record): a step sent again adds
// nothing. Reads `records` only (the engine never writes it, so source_day_counts stays the ingest's alone).
import type { Filter } from "@starterkit/shared/contracts/recon";
import { type SQL, sql } from "drizzle-orm";
import { records } from "../../ingest";
import { reconItems } from "../schema";
import { fieldSql, type SideRef, type StepCtx } from "./pass";

const CAST = { text: sql``, decimal: sql`::numeric`, date: sql`::date`, boolean: sql`::boolean` } as const;

/** A side filter as SQL over `records` (closed operators, values bound and cast to the field's kind). */
export function filterSql(s: SideRef, f: Filter): SQL {
  const x = fieldSql(s, f.field);
  const cast = CAST[s.fields.get(f.field)!.kind];
  const list = (vs: string[]) => sql.join(vs.map((v) => sql`${v}${cast}`), sql`, `);
  switch (f.op) {
    case "eq": return sql`${x} = ${f.value}${cast}`;
    case "ne": return sql`${x} is distinct from ${f.value}${cast}`;
    case "in": return sql`${x} in (${list(f.values)})`;
    case "not_in": return sql`(${x} is null or ${x} not in (${list(f.values)}))`;
    case "is_null": return sql`${x} is null`;
    case "not_null": return sql`${x} is not null`;
  }
}

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

/**
 * Closes side `s`'s open items of the window whose record no longer counts (a mutable source replaced the row, or its
 * snapshot is no longer active): status closed, reason "Source row replaced", so they never wait or count as open.
 * Only items this statement locks (A1). TODO(Task 6 / Plan 5): a matched or suggested group whose record was replaced
 * is reversed (`reversed_by`, reason source_changed, spec §8) and its items reopened; not done here.
 */
export function closeReplacedSql(c: StepCtx, s: 0 | 1): SQL {
  const side = c.sides[s];
  return sql`with t as (select i.id, i.version as v, i.business_date as bd from ${reconItems} i
      where i.space_id = ${c.spaceId} and i.config_id = ${c.configId} and i.side = ${side.key} and i.status = 'open'
        and ${c.simRunId === null ? sql`i.sim_run_id is null` : sql`i.sim_run_id = ${c.simRunId}`}
        and i.business_date between ${c.lo}::date and ${c.hi}::date
        and not exists (select 1 from ${records} where ${records.spaceId} = ${side.sourceSpaceId} and ${records.sourceId} = ${side.sourceId}
          and ${records.id} = i.record_id and ${records.businessDate} = i.business_date and ${c.current})
      for update of i skip locked),
  up as (update ${reconItems} i set status = 'closed', break_reason = ${REPLACED}, version = i.version + 1
      from t x where i.space_id = ${c.spaceId} and i.id = x.id and i.business_date = x.bd and i.status = 'open' and i.version = x.v returning i.id)
  select count(*)::int as n from up`;
}
/** The reason an item closes when its record no longer counts. */
export const REPLACED = "Source row replaced";
