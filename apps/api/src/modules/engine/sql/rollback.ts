// A rollback of live runs (rollback.ts): what they matched and broke undone, set-based. Every statement reads live
// rows only (sim_run_id null) of one config, and names the runs as a bound uuid array.
import { type SQL, sql } from "drizzle-orm";
import { approvalRequests } from "../../approvals";
import { matchGroups, matchMembers, reconDays, reconItems } from "../schema";
import { datesOf } from "./pass";

/** The config and the runs a rollback undoes. */
export type RollbackCtx = { spaceId: string; configId: string; runIds: readonly string[] };

/** Why a rollback reversed a group (match_groups.reverse_reason). */
export const ROLLED_BACK = "rolled_back";

const runs = (k: RollbackCtx) => sql`${`{${k.runIds.join(",")}}`}::uuid[]`;

/**
 * The live items the runs decided and still stand as they left them: the members of their groups not reversed, and
 * the items they broke (or made not required) that are still breaks (or not required). As CTE `touched` (id, bd).
 */
const touched = (k: RollbackCtx): SQL => sql`grp as materialized (select g.id, g.business_date as bd from ${matchGroups} g
      where g.space_id = ${k.spaceId} and g.config_id = ${k.configId} and g.sim_run_id is null and g.reversed_by is null and g.run_id = any(${runs(k)})),
  touched as materialized (select m.item_id as id, i.business_date as bd from ${matchMembers} m
        join ${reconItems} i on i.space_id = m.space_id and i.id = m.item_id
      where m.space_id = ${k.spaceId} and m.group_id in (select id from grp) and i.config_id = ${k.configId}
    union select i.id, i.business_date from ${reconItems} i
      where i.space_id = ${k.spaceId} and i.config_id = ${k.configId} and i.sim_run_id is null
        and i.break_run_id = any(${runs(k)}) and i.status in ('break', 'not_required'))`;

/**
 * What refuses the rollback, read before it changes anything: `closed` = the first signed-off business date (DEC-064) of a group, a
 * member or a break it would change (null when none); `held` = whether a change of one of those items waits for a
 * decision (a pending approval request names it). Reads only.
 */
export function rollbackBlockersSql(k: RollbackCtx): SQL {
  return sql`with ${touched(k)},
  dates as (select bd from touched union select bd from grp)
  select (select min(d.business_date)::text from ${reconDays} d where d.space_id = ${k.spaceId} and d.config_id = ${k.configId} and d.signed_at is not null
      and d.business_date in (select bd from dates)) as closed,
    exists (select 1 from ${approvalRequests} r where r.space_id = ${k.spaceId} and r.status = 'pending'
      and (r.item_id in (select id from touched) or r.item_ids && (select coalesce(array_agg(id), '{}') from touched))) as held`;
}

/**
 * Reverses the runs' live groups not reversed yet (reversed_by = `by`, the rerun that rolls them back; reason
 * ROLLED_BACK) and puts each member back where it stood before (as an approved unmatch does): a break a pass paired as
 * late data is a break again (its queue state: assigned when someone has it), every other item open. Every member is
 * locked first. Answers { groups, items, dates }.
 */
export function reverseRunGroupsSql(k: RollbackCtx, by: string): SQL {
  return sql`with grp as materialized (select g.id from ${matchGroups} g
      where g.space_id = ${k.spaceId} and g.config_id = ${k.configId} and g.sim_run_id is null and g.reversed_by is null and g.run_id = any(${runs(k)}) for update),
  lk as materialized (select i.id, i.business_date as bd from ${matchMembers} m join ${reconItems} i on i.space_id = m.space_id and i.id = m.item_id
      where m.space_id = ${k.spaceId} and m.group_id in (select id from grp) and i.config_id = ${k.configId} and i.sim_run_id is null
        and i.status in ('matched', 'suggested') for update of i),
  rg as (update ${matchGroups} g set reversed_by = ${by}::uuid, reverse_reason = ${ROLLED_BACK}, reversed_at = now()
      where g.space_id = ${k.spaceId} and g.id in (select id from grp) returning g.id),
  up as (update ${reconItems} i set status = case when i.break_reason is null then 'open' else 'break' end,
      break_state = case when i.break_reason is null or i.assignee_id is null then null else 'assigned' end,
      resolution = null, state_at = now(), version = i.version + 1
      from lk where i.space_id = ${k.spaceId} and i.id = lk.id and i.business_date = lk.bd returning i.business_date as bd)
  select (select count(*) from rg)::int as groups, (select count(*) from up)::int as items, ${datesOf("up")}`;
}

/**
 * Puts the live items the runs broke (or made not required) that are still breaks (or not required) back to open, as
 * before the run: no reason, pass, late match, proposal, queue state or assignee. Run after reverseRunGroupsSql, so a
 * late-data break one of the runs paired, and another of them broke, ends open too. Answers { items, dates }.
 */
export function reopenRunBreaksSql(k: RollbackCtx): SQL {
  return sql`with lk as materialized (select i.id, i.business_date as bd from ${reconItems} i
      where i.space_id = ${k.spaceId} and i.config_id = ${k.configId} and i.sim_run_id is null
        and i.break_run_id = any(${runs(k)}) and i.status in ('break', 'not_required') for update),
  up as (update ${reconItems} i set status = 'open', break_reason = null, break_pass = null, late_match = false, resolution = null,
      proposed_item_id = null, proposed_pass = null, break_state = null, assignee_id = null, state_at = null, break_run_id = null,
      version = i.version + 1
      from lk where i.space_id = ${k.spaceId} and i.id = lk.id and i.business_date = lk.bd returning i.business_date as bd)
  select (select count(*) from up)::int as items, ${datesOf("up")}`;
}
