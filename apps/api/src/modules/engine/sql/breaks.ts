// Breaks the engine writes during a run (spec §10 on_ambiguous = break): the items a pass found but could not pair
// without guessing. The day-close breaks (Task 6) join them here. Same rules as pass.ts: values bound, an item changed
// only when this statement locked it and while open at the version read (A1). A conflict that reaches an item another
// transaction holds is left as it is, whole: breaking its other items would decide it without that item.
import type { PassSpec } from "@starterkit/shared/contracts/recon";
import { type SQL, sql } from "drizzle-orm";
import { records } from "../../ingest";
import { reconItems } from "../schema";
import { candidatesSql, comparedAmount, groupsSql, type StepCtx } from "./pass";

/**
 * Why an ambiguous item broke: "Duplicate" when the pass finds candidates through a key (its matching keys or an
 * equality: the key is doubled on a side, spec §10), "Ambiguous" for a pass without one.
 */
export const breakReason = (p: PassSpec): string =>
  p.blocking.length || p.predicates.some((q) => q.op === "eq" || q.op === "eq_normalized") ? "Duplicate" : "Ambiguous";

/**
 * Breaks the items of CTE `t` (id, v, bd) as pass `p`'s (`break_pass`); answers the items, those of side A, and their
 * distinct references (the records' ext_ref: a Duplicate counts keys, "10 references, 30 items").
 */
const breakItems = (c: StepCtx, p: PassSpec): SQL => sql`up as (update ${reconItems} i set status = 'break', break_reason = ${breakReason(p)}, break_pass = ${p.no}, version = i.version + 1
    from t x where i.space_id = ${c.spaceId} and i.id = x.id and i.business_date = x.bd and i.status in ('open', 'not_required') and i.version = x.v returning i.record_id, i.business_date, i.side)
  select count(*)::int as items, count(*) filter (where up.side = 'a')::int as a, (select count(distinct r.ext_ref)::int from up join ${records} r on r.space_id in (${c.sides[0].sourceSpaceId}, ${c.sides[1].sourceSpaceId})
    and r.id = up.record_id and r.business_date = up.business_date) as refs, string_agg(distinct up.business_date::text, ',') as dates from up`;

/**
 * 1:1, once no pair is taken: every item still with a candidate is in a tie; all of them break, but for the items two
 * candidate steps or less from a held one (`near`: a key's items are each other's candidates, so the whole key; a
 * ponytail for chains of tolerance ties, which reach further only through a third hop).
 */
export function tieBreakSql(c: StepCtx, p: PassSpec): SQL {
  return sql`with ${candidatesSql(c, p)},
  held as (select a_id as id from c where not a_lk union select b_id from c where not b_lk),
  hop as (select id from held union select b_id from c where a_id in (select id from held) union select a_id from c where b_id in (select id from held)),
  near as (select id from hop union select b_id from c where a_id in (select id from hop) union select a_id from c where b_id in (select id from hop)),
  t as (select a_id as id, a_v as v, a_bd as bd from c where a_id not in (select id from near)
    union select b_id, b_v, b_bd from c where b_id not in (select id from near)),
  ${breakItems(c, p)}`;
}

/**
 * 1:N / N:1: the items of every group whose many-side items another one-side item claims too, when every group of
 * that conflict is locked whole.
 */
export function groupBreakSql(c: StepCtx, p: PassSpec): SQL {
  return sql`with ${groupsSql(c, p)},
  bad as (select g.o_id from grp g where not g.uniq and g.all_lk and not exists (
    select 1 from cm x join cm y on y.m_id = x.m_id join grp g2 on g2.o_id = y.o_id where x.o_id = g.o_id and not g2.all_lk)),
  t as (select o_id as id, o_v as v, o_bd as bd from cm where o_id in (select o_id from bad)
    union select m_id, m_v, m_bd from cm where o_id in (select o_id from bad)),
  ${breakItems(c, p)}`;
}

/** Why an item without a pair is a break (day close; the plan's "Alasan break saat tutup hari"). */
export const NEAR_MISS = { currency: "Currency differs", amount: "Amount differs", date: "Date differs", none: "No counterpart" } as const;
/**
 * A one-way recon's side-B item with no near pair (DEC-055): no break, the item becomes `not_required`. Not a break
 * reason (BREAK_REASONS): the classifier answers it in place of "No counterpart", for side B of a one-way recon only.
 */
export const NOT_REQUIRED = "Not required";
export type NearMissReason = (typeof NEAR_MISS)[keyof typeof NEAR_MISS] | typeof NOT_REQUIRED;

/**
 * What the classifier reads: the config's items (live or a simulation's), its sides, and carry over: an item's
 * counterparts are of its own date or up to `carry` days before it (what the pool of its own date's run held).
 */
export type ClassifyCtx = Pick<StepCtx, "spaceId" | "configId" | "simRunId" | "sides" | "current" | "oneWay"> & { carry: number };

/**
 * Side `s`'s items of `c` (live or the simulation's) with status in `statuses` and business date `from`..`to` (plus
 * `only`: a condition on `i`), with their record's reference, currency, compared amount (the side's sign convention,
 * as the passes compare) and order fields.
 */
const sideItems = (c: ClassifyCtx, s: 0 | 1, statuses: SQL, from: SQL, to: string, only?: SQL): SQL => {
  const side = c.sides[s];
  return sql`select i.id, i.side, i.business_date as bd, ${records.extRef} as ref, ${records.currency} as ccy, ${comparedAmount(side)} as amt,
      ${records.eventTime} as et, ${records.id} as rid
    from ${reconItems} i join ${records} on ${records.spaceId} = ${side.sourceSpaceId} and ${records.sourceId} = ${side.sourceId}
      and ${records.id} = i.record_id and ${records.businessDate} = i.business_date and ${c.current}
    where i.space_id = ${c.spaceId} and i.config_id = ${c.configId} and i.side = ${side.key} and i.status in (${statuses})
      and ${c.simRunId === null ? sql`i.sim_run_id is null` : sql`i.sim_run_id = ${c.simRunId}`}
      and i.business_date between ${from} and ${to}::date${only ? sql` and ${only}` : sql``}`;
};

/**
 * The near-miss classifier (one rule for day close and simulation, Captain): every open item of business dates
 * `from`..`to` (and `only`, a condition on its `i`, for a few) with the reason it has no pair and, where there is one,
 * its near pair. Reads only. The near pair is the other side's unpaired item (open, break or not required) with the same reference,
 * of the item's date or up to carry over days before it (so a simulation over several dates judges each item as its
 * own date's close does), the closest first: same currency, then the smallest amount difference, then the nearest
 * date, then record order. Its reason is the first field that differs: currency, amount (compared amounts, each side's
 * sign convention), business date. No item with that reference on the other side, or one that differs in none of the
 * three (it failed another predicate, or an operator holds it) = "No counterpart" without a pair. One hash join on the
 * reference, no scan per item. A one-way recon's (`oneWay`) side-B item that way is NOT_REQUIRED instead, but only when no
 * side-A item of its reference is in the window in any status but closed (one matched, suggested or broken with another
 * side-B item makes this one a double settlement: it stays "No counterpart"). Rows: item_id, side, business_date, reason, pair_item_id.
 */
export function nearMissSql(c: ClassifyCtx, from: string, to: string, only?: SQL): SQL {
  const open = sql`'open'`, unpaired = sql`'open', 'break', 'not_required'`;
  const lo = sql`(${from}::date - ${c.carry}::int)`;
  return sql`with m as materialized (${sideItems(c, 0, open, sql`${from}::date`, to, only)} union all ${sideItems(c, 1, open, sql`${from}::date`, to, only)}),
  o as materialized (${sideItems(c, 0, unpaired, lo, to)} union all ${sideItems(c, 1, unpaired, lo, to)}),
  p as (select m.id, m.side, m.bd, m.ref, o.id as pid, case
      when o.id is null then null
      when o.ccy is distinct from m.ccy then ${NEAR_MISS.currency}
      when o.amt is distinct from m.amt then ${NEAR_MISS.amount}
      when o.bd <> m.bd then ${NEAR_MISS.date} end as reason,
      row_number() over (partition by m.id order by (o.ccy is distinct from m.ccy), abs(o.amt - m.amt) nulls last, abs(o.bd - m.bd), o.bd, o.et, o.rid) as rn
    from m left join o on o.ref = m.ref and o.side <> m.side and o.bd between m.bd - ${c.carry}::int and m.bd),
  k as (select * from p where rn = 1)${c.oneWay ? sql`,
  ax as materialized (select ref, bd from (${sideItems(c, 0, sql`'open', 'matched', 'suggested', 'break', 'not_required'`, lo, to)}) s)` : sql``}
  select id as item_id, side, bd::text as business_date, coalesce(reason, ${c.oneWay
    ? sql`case when side = 'b' and not exists (select 1 from ax where ax.ref = k.ref and ax.bd >= k.bd - ${c.carry}::int) then ${NOT_REQUIRED} end`
    : sql`null`}, ${NEAR_MISS.none}) as reason, case when reason is null then null else pid end as pair_item_id
  from k order by bd, side, id`;
}
