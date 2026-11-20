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

/** Inserts side `s`'s new items for the window; answers how many. */
export function intakeSql(c: StepCtx, s: 0 | 1, filters: readonly Filter[]): SQL {
  const side = c.sides[s];
  const where = [
    sql`${records.spaceId} = ${side.sourceSpaceId}`, sql`${records.sourceId} = ${side.sourceId}`,
    sql`${records.businessDate} between ${c.lo}::date and ${c.hi}::date`, c.current, ...filters.map((f) => filterSql(side, f)),
    // a record with an item already is skipped here, not by ON CONFLICT: that would wait on an item an operator holds (A1)
    sql`not exists (select 1 from ${reconItems} x where x.space_id = ${c.spaceId} and x.config_id = ${c.configId} and x.record_id = ${records.id}
      and x.business_date = ${records.businessDate} and ${c.simRunId === null ? sql`x.sim_run_id is null` : sql`x.sim_run_id = ${c.simRunId}`})`,
  ];
  return sql`with ins as (insert into ${reconItems} (id, space_id, config_id, record_id, side, business_date, sim_run_id)
    select uuidv7(), ${c.spaceId}::uuid, ${c.configId}::uuid, ${records.id}, ${side.key}::text, ${records.businessDate}, ${c.simRunId}::uuid
    from ${records} where ${sql.join(where, sql` and `)}
    on conflict do nothing returning 1)
  select count(*)::int as n from ins`;
}
