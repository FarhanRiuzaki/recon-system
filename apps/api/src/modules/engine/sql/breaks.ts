// Breaks the engine writes during a run (spec §10 on_ambiguous = break): the items a pass found but could not pair
// without guessing. The day-close breaks (Task 6) join them here. Same rules as pass.ts: values bound, an item changed
// only when this statement locked it and while open at the version read (A1). A conflict that reaches an item another
// transaction holds is left as it is, whole: breaking its other items would decide it without that item.
import type { PassSpec } from "@starterkit/shared/contracts/recon";
import { type SQL, sql } from "drizzle-orm";
import { reconItems } from "../schema";
import { candidatesSql, groupsSql, type StepCtx } from "./pass";

/**
 * Why an ambiguous item broke: "Duplicate" when the pass finds candidates through a key (its matching keys or an
 * equality: the key is doubled on a side, spec §10), "Ambiguous" for a pass without one.
 */
export const breakReason = (p: PassSpec): string =>
  p.blocking.length || p.predicates.some((q) => q.op === "eq" || q.op === "eq_normalized") ? "Duplicate" : "Ambiguous";

/** Breaks the items of CTE `t` (id, v, bd). */
const breakItems = (c: StepCtx, reason: string): SQL => sql`up as (update ${reconItems} i set status = 'break', break_reason = ${reason}, version = i.version + 1
    from t x where i.space_id = ${c.spaceId} and i.id = x.id and i.business_date = x.bd and i.status = 'open' and i.version = x.v returning i.id)
  select count(*)::int as items from up`;

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
  ${breakItems(c, breakReason(p))}`;
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
  ${breakItems(c, breakReason(p))}`;
}
