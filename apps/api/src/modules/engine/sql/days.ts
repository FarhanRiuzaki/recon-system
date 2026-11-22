// The breaks of time (spec §9 run tick step 4 and "Tutup hari", DEC-043, DEC-046): grace and day close. Both take
// their reasons from the near-miss classifier (breaks.ts nearMissSql, the one rule simulation shows too) and change an
// item only when this statement locked it, at the status and version read (A1). Live items only.
import { type SQL, sql } from "drizzle-orm";
import { records, sourceCursors } from "../../ingest";
import { matchGroups, matchMembers, reconItems } from "../schema";
import { type ClassifyCtx, NEAR_MISS, nearMissSql } from "./breaks";
import { CHOSEN, type StepCtx } from "./pass";

/**
 * The reasons of an unconfirmed suggestion at day close (DEC-046). A suggestion of a tie (CHOSEN.tie: the pass had more
 * than one best candidate) is a "Duplicate" first, with its pass in break_pass like a pass's own ambiguity breaks,
 * whatever its deltas: the person has to choose among candidates, not judge one difference. Else from its pass's
 * evidence: a non-zero amount delta, then a non-zero date delta, else "Unconfirmed suggestion".
 */
export const SUGGESTED_REASON = { amount: "Amount differs", date: "Date differs", tie: "Duplicate", other: "Unconfirmed suggestion" } as const;

const live = (c: Pick<ClassifyCtx, "simRunId">, alias: string): SQL => (c.simRunId === null ? sql.raw(`${alias}.sim_run_id is null`) : sql`${sql.raw(alias)}.sim_run_id = ${c.simRunId}`);

/**
 * Breaks the items of CTE `lk` (id, v, st, bd), each with `reason`, late_match `late` and break_pass `pass` (SQL over
 * lk and k / sg; break_pass names the pass of a Duplicate, as a pass's own ambiguity breaks do).
 */
const breakLocked = (c: Pick<ClassifyCtx, "spaceId">, from: SQL, reason: SQL, late: SQL, pass: SQL = sql`i.break_pass`): SQL => sql`up as (update ${reconItems} i set status = 'break', break_reason = ${reason}, late_match = ${late},
      break_pass = ${pass}, version = i.version + 1
    from ${from} where i.space_id = ${c.spaceId} and i.id = lk.id and i.business_date = lk.bd and i.status = lk.st and i.version = lk.v returning lk.st, lk.bd)`;

/**
 * Grace (spec §9 step 4): each open item of the window whose record's event time plus `graceMinutes` is at or before
 * the other side's source complete_through: that source has delivered past the item's time with room to spare, and no
 * counterpart came. It breaks with its near-miss reason; a "No counterpart" break may still meet a late counterpart
 * (late_match, DEC-047), a near miss (currency, amount, date differs) keeps its pair for a person. An
 * item without an event time (a file or snapshot source) waits for day close. Answers { n }.
 */
export function graceSql(c: StepCtx, graceMinutes: number, carry: number): SQL {
  const due = ([0, 1] as const).map((s) => {
    const side = c.sides[s], other = c.sides[1 - s]!;
    return sql`select i.id from ${reconItems} i join ${records} on ${records.spaceId} = ${side.sourceSpaceId} and ${records.sourceId} = ${side.sourceId}
        and ${records.id} = i.record_id and ${records.businessDate} = i.business_date and ${c.current}
      where i.space_id = ${c.spaceId} and i.config_id = ${c.configId} and i.side = ${side.key} and i.status = 'open' and ${live(c, "i")}
        and i.business_date between ${c.lo}::date and ${c.hi}::date and ${records.eventTime} is not null
        and ${records.eventTime} + make_interval(mins => ${graceMinutes}::int) <= (select ${sourceCursors.completeThrough} from ${sourceCursors}
          where ${sourceCursors.spaceId} = ${other.sourceSpaceId} and ${sourceCursors.sourceId} = ${other.sourceId})`;
  });
  return sql`with due as materialized (${due[0]} union all ${due[1]}),
  lk as materialized (select i.id, i.version as v, i.status as st, i.business_date as bd from ${reconItems} i
    where i.space_id = ${c.spaceId} and i.config_id = ${c.configId} and ${live(c, "i")} and i.business_date between ${c.lo}::date and ${c.hi}::date
      and i.status = 'open' and i.id in (select id from due) for update skip locked),
  k as (${nearMissSql({ ...c, carry }, c.lo, c.hi, sql`i.id in (select id from lk)`)}),
  ${breakLocked(c, sql`lk join k on k.item_id = lk.id`, sql`k.reason`, sql`k.reason = ${NEAR_MISS.none}`)}
  select count(*)::int as n from up`;
}

/**
 * Day close (DEC-046, minimal in phase 1): in the window `lo`..`hi` (the closing date and the carry over before it; or
 * closed dates again, for what a close skipped), every open item breaks with its near-miss reason (late_match only for "No counterpart": a late counterpart may still close it when carry
 * over > 0), and every item of an unconfirmed suggestion dated there breaks with its pass's reason, its suggested group
 * kept as the pair to accept in one click (not late_match: a person decides it); a tie suggestion breaks as Duplicate
 * with its pass in break_pass, like a pass's own ambiguity breaks. Answers per business date of the items broken
 * { d, open, suggested } (REC-FUT-17: each date's counters count its own items).
 */
export function closeDaySql(c: ClassifyCtx, lo: string, hi: string): SQL {
  const has = (ops: string[]) => sql`exists (select 1 from jsonb_array_elements(g.evidence -> 'predicates') e
      where e ->> 'op' in (${sql.join(ops.map((o) => sql`${o}`), sql`, `)}) and coalesce((e ->> 'delta')::numeric, 0) <> 0)`;
  return sql`with sg as materialized (select m.item_id as id, case
        when g.evidence ->> 'chosen' = ${CHOSEN.tie} then ${SUGGESTED_REASON.tie}
        when ${has(["amount_abs_tol", "amount_pct_tol", "eq_sum"])} then ${SUGGESTED_REASON.amount}
        when ${has(["date_window", "bday_window"])} then ${SUGGESTED_REASON.date}
        else ${SUGGESTED_REASON.other} end as reason, g.pass_no
      from ${matchGroups} g join ${matchMembers} m on m.space_id = g.space_id and m.group_id = g.id
      where g.space_id = ${c.spaceId} and g.config_id = ${c.configId} and ${live(c, "g")} and g.kind = 'suggested' and g.reversed_by is null
        and g.business_date between ${lo}::date and ${hi}::date),
  lk as materialized (select i.id, i.version as v, i.status as st, i.business_date as bd from ${reconItems} i
    where i.space_id = ${c.spaceId} and i.config_id = ${c.configId} and ${live(c, "i")} and i.business_date between ${lo}::date and ${hi}::date
      and (i.status = 'open' or (i.status = 'suggested' and i.id in (select id from sg))) for update skip locked),
  k as (${nearMissSql(c, lo, hi, sql`i.id in (select id from lk)`)}),
  ${breakLocked(c, sql`lk left join k on k.item_id = lk.id left join sg on sg.id = lk.id`, sql`case when lk.st = 'open' then k.reason else sg.reason end`, sql`lk.st = 'open' and k.reason = ${NEAR_MISS.none}`,
    sql`case when lk.st = 'suggested' and sg.reason = ${SUGGESTED_REASON.tie} then sg.pass_no else i.break_pass end`)}
  select bd::text as d, count(*) filter (where st = 'open')::int as open, count(*) filter (where st = 'suggested')::int as suggested from up group by bd order by bd`;
}
