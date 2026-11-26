// The end of a live run's step (DEC-064, no day close; it replaced grace and day close, DEC-043, DEC-046): what stays
// open breaks with the near-miss classifier's reason (breaks.ts nearMissSql, the one rule simulation shows too), each
// item only when this statement locked it, at the status and version read (A1). Live items only.
import { type SQL, sql } from "drizzle-orm";
import { reconConfigs } from "../../recon";
import { reconDayStats, reconItems } from "../schema";
import { type ClassifyCtx, NEAR_MISS, nearMissSql, NOT_REQUIRED } from "./breaks";
import { datesOf, type StepCtx } from "./pass";

/**
 * The reasons an unconfirmed suggestion broke with at day close (DEC-046, before DEC-064): stored breaks keep them, the
 * break reasons list (BREAK_REASONS) names them.
 */
export const SUGGESTED_REASON = { amount: "Amount differs", date: "Date differs", tie: "Duplicate", other: "Unconfirmed suggestion" } as const;

const live = (c: Pick<ClassifyCtx, "simRunId">, alias: string): SQL => (c.simRunId === null ? sql.raw(`${alias}.sim_run_id is null`) : sql`${sql.raw(alias)}.sim_run_id = ${c.simRunId}`);

/**
 * Breaks the items of CTE `lk` (id, v, st, bd), each with `reason`, late_match `late` and break_pass `pass` (SQL over
 * lk and k / sg; break_pass names the pass of a Duplicate, as a pass's own ambiguity breaks do) and break_run_id
 * `runId` (the run, which a rollback of it reads). An item whose reason
 * is NOT_REQUIRED (a one-way recon's side B, DEC-055) becomes not_required instead: no break reason, no work item; the
 * pool reads it by its status. Returns lk.st, lk.bd and the new status (`ns`).
 */
const breakLocked = (c: Pick<ClassifyCtx, "spaceId">, from: SQL, reason: SQL, late: SQL, pass: SQL, runId: string | null): SQL => sql`up as (update ${reconItems} i
      set status = case when ${reason} = ${NOT_REQUIRED} then 'not_required' else 'break' end,
      break_reason = nullif(${reason}, ${NOT_REQUIRED}), late_match = ${late} and ${reason} <> ${NOT_REQUIRED},
      break_pass = ${pass}, break_run_id = ${runId}::uuid, version = i.version + 1
    from ${from} where i.space_id = ${c.spaceId} and i.id = lk.id and i.business_date = lk.bd and i.status = lk.st and i.version = lk.v returning lk.st, lk.bd, i.status as ns)`;

/**
 * The end of a live run's step (DEC-064, no day close): every open item of the window `lo`..`hi` breaks at once with its
 * near-miss reason (sql/breaks.ts nearMissSql: "No counterpart", or what differs from its near pair; a one-way recon's
 * side-B item is not required instead), `break_run_id` the run. The next runs pair it again within carry over (the
 * pool holds every unmatch, sql/pass.ts poolStatus). An item another transaction holds waits for the next run (A1).
 * Suggested items keep waiting for a person. Answers { n } and the dates it changed.
 */
export function breakOpenSql(c: StepCtx, carry: number): SQL {
  return sql`with lk as materialized (select i.id, i.version as v, i.status as st, i.business_date as bd from ${reconItems} i
    where i.space_id = ${c.spaceId} and i.config_id = ${c.configId} and ${live(c, "i")} and i.business_date between ${c.lo}::date and ${c.hi}::date
      and i.status = 'open' for update skip locked),
  k as (${nearMissSql({ ...c, carry }, c.lo, c.hi, sql`i.id in (select id from lk)`)}),
  ${breakLocked(c, sql`lk join k on k.item_id = lk.id`, sql`k.reason`, sql`k.reason = ${NEAR_MISS.none}`, sql`i.break_pass`, c.runId)}
  select (select count(*) from up)::int as n, ${datesOf("up")}`;
}

/**
 * The dashboard rollup's gaps (stats.ts, C2): each (space, config, business date) of configs of `spaceIds` (`configId`:
 * one) in `from`..`to` that holds a live item and has no recon_day_stats row yet. One index probe per config and date
 * (recon_items_config_date, the stats key), never a scan of the items. Rows: space_id, config_id, d.
 */
export function missingDaysSql(spaceIds: readonly string[], configId: string | null, from: string, to: string): SQL {
  return sql`select c.space_id, c.id as config_id, d::date::text as d
    from ${reconConfigs} c cross join generate_series(${from}::date, ${to}::date, interval '1 day') d
    where c.space_id in (${sql.join(spaceIds.map((id) => sql`${id}::uuid`), sql`, `)})${configId ? sql` and c.id = ${configId}::uuid` : sql``}
      and exists (select 1 from ${reconItems} i where i.space_id = c.space_id and i.config_id = c.id and i.business_date = d::date and i.sim_run_id is null)
      and not exists (select 1 from ${reconDayStats} s where s.space_id = c.space_id and s.config_id = c.id and s.business_date = d::date)
    order by d, c.id`;
}
