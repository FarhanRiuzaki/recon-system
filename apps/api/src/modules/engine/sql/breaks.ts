// Breaks the engine writes during a run (spec §10 on_ambiguous = break): the items a pass found but could not pair
// without guessing. The day-close breaks (Task 6) join them here. Same rules as pass.ts: values bound, the pools locked
// `skip locked`, an item changed only while open at the version read (A1).
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

/** 1:1, once no pair is mutual unique best: every item still with a candidate is in a tie; all of them break. */
export function tieBreakSql(c: StepCtx, p: PassSpec): SQL {
  return sql`with ${candidatesSql(c, p)},
  t as (select a_id as id, a_v as v, a_bd as bd from c union select b_id, b_v, b_bd from c),
  ${breakItems(c, breakReason(p))}`;
}

/** 1:N / N:1: the items of every group whose many-side items another one-side item claims too. */
export function groupBreakSql(c: StepCtx, p: PassSpec): SQL {
  return sql`with ${groupsSql(c, p)},
  bad as (select o_id from grp where not uniq),
  t as (select o_id as id, o_v as v, o_bd as bd from cm where o_id in (select o_id from bad)
    union select m_id, m_v, m_bd from cm where o_id in (select o_id from bad)),
  ${breakItems(c, breakReason(p))}`;
}
