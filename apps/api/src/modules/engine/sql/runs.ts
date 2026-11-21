// What a run adds around its passes: fresh planner statistics after a large intake, and a draft simulation's changes
// against the published version's simulation over the same dates.
import { type SQL, sql } from "drizzle-orm";
import { matchGroups, matchMembers, reconItems, reconRuns, reconSimChanges } from "../schema";

/**
 * Refreshes the statistics of `table`'s month partitions of `lo`..`hi` whose rows changed since their last analyze
 * (plus `added`, rows this transaction just wrote) are many against what the statistics count: autovacuum's rule, now
 * (recon_analyze_month_partitions, drizzle/0026: ANALYZE runs as the owner). Planned over a fresh partition's
 * statistics, intake and the passes turn into nested loops: 20,000 items a side ran past 30 s (docs/recon/spikes.md
 * "Plan 3 engine"). Answers how many partitions it analyzed.
 */
export const analyzeSql = (table: "records" | "recon_items", lo: string, hi: string, added: number): SQL =>
  sql`select recon_analyze_month_partitions(${table}::regclass, ${lo}::date, ${hi}::date, ${added}::int) as n`;

/** Refreshes match_groups' or match_members' statistics after a run wrote `added` rows (recon_analyze_table, 0033). */
export const analyzeTableSql = (table: "match_groups" | "match_members", added: number): SQL =>
  sql`select recon_analyze_table(${table}::regclass, ${added}::int) as analyzed`;

/**
 * Writes simulation `runId`'s changes against simulation `baselineId` (null: no published version, every pair gained)
 * into recon_sim_changes, one row per changed pair of live (not reversed) groups, compared by their records' ids (each
 * simulation has items of its own): the same records with another kind = `kind`; a draft group sharing some records
 * with a published one = `repaired` (one row per such pair); a draft group sharing none = `gained`; a published group
 * sharing none = `lost`. Dated by the draft group's date, else the published one's. Answers the count per change.
 */
export function changesSql(spaceId: string, runId: string, baselineId: string | null): SQL {
  const groups = (run: string | null) => sql`select g.id, g.kind, g.business_date as bd, array_agg(i.record_id order by i.record_id) as recs
      from ${matchGroups} g join ${matchMembers} m on m.space_id = g.space_id and m.group_id = g.id
      join ${reconItems} i on i.space_id = m.space_id and i.id = m.item_id
      where g.space_id = ${spaceId} and g.run_id = ${run}::uuid and g.reversed_by is null group by g.id`;
  return sql`with d as materialized (${groups(runId)}), p as materialized (${groups(baselineId)}),
  pairs as (select distinct d.id as did, p.id as pid from (select id, unnest(recs) as r from d) d join (select id, unnest(recs) as r from p) p using (r)),
  ch as (
    select 'kind' as change, d.id as did, p.id as pid, d.bd from d join p on p.recs = d.recs where p.kind <> d.kind
    union all select 'repaired', d.id, p.id, d.bd from pairs x join d on d.id = x.did join p on p.id = x.pid where p.recs <> d.recs
    union all select 'gained', d.id, null, d.bd from d where not exists (select 1 from pairs x where x.did = d.id)
    union all select 'lost', null, p.id, p.bd from p where not exists (select 1 from pairs x where x.pid = p.id)),
  ins as (insert into ${reconSimChanges} (id, space_id, run_id, change, draft_group_id, published_group_id, business_date)
    select uuidv7(), ${spaceId}::uuid, ${runId}::uuid, change, did, pid, bd from ch returning change)
  select count(*) filter (where change = 'gained')::int as gained, count(*) filter (where change = 'lost')::int as lost,
    count(*) filter (where change = 'repaired')::int as repaired, count(*) filter (where change = 'kind')::int as kind from ins`;
}


/**
 * A run whose stored days (recon_runs.days) hold current records on its own dates (`items` a + b over from..to > 0):
 * GET …/runs?records=1. A run without days (not finalized) is not one.
 */
export const runHasRecordsSql = (): SQL => sql`exists (select 1 from jsonb_array_elements(case when jsonb_typeof(${reconRuns.days}) = 'array' then ${reconRuns.days} else '[]'::jsonb end) d
    where (d ->> 'date')::date between ${reconRuns.dateFrom} and ${reconRuns.dateTo}
      and coalesce((d -> 'items' ->> 'a')::int, 0) + coalesce((d -> 'items' ->> 'b')::int, 0) > 0)`;
