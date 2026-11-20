// A pass of a recon spec compiled to one set-based statement per step (spec §10, spike S1). boundaries.test.ts
// allowlists modules/engine/sql/ as the one place the engine writes SQL by hand. Values (ids, dates, tolerances, the
// attribute names) are bound parameters; identifiers are fixed here: a core field maps to its `records` column through
// CORE below, an attribute is `records.attrs ->> $name` (bound; records has no promoted attribute columns yet, and the
// pass needs none: the pool is read through recon_items_open and the records primary key, and the candidate join is a
// hash join between the two pools), every field checked against the side's whitelist (recordFields of its published
// source version), operators only the closed list (spec §10).
//
// Shape of every statement (S1): two pools, side A's and side B's open items of the business-date window joined to
// their current records, locked `for update of i skip locked` (an item another transaction holds is left alone, A1),
// then the candidates (the pass's matching keys and equalities as the join, the other conditions as a filter, a
// distance per tolerance), then a choice, then the writes as data-modifying CTEs: items claimed with
// `status = 'open' and version = v`, groups and members inserted. A step's statements run in one transaction.
//
// The choice, 1:1 (accept): a pair is taken only when it is mutual unique best, each the other's only candidate at the
// smallest distance (lexicographic over the pass's tolerances in order). Ties are left to on_ambiguous: break
// (breaks.ts) or suggest (tieSuggest: the earliest business date, then id, of each side's tied candidates). A group pass
// (1:N / N:1) groups the many side's candidates by its one-side item and compares the sum (eq_sum); a many-side item
// that two one-side items claim is ambiguous.
import type { PassSpec, Predicate } from "@starterkit/shared/contracts/recon";
import { ATTR_NAME, CURRENCY_EXPONENT, DEBIT_CODES, toMinor } from "@starterkit/shared/sources";
import { type FieldKind, type RecordField, sideRef } from "@starterkit/shared/recon";
import { type SQL, sql } from "drizzle-orm";
import { records } from "../../ingest";
import { matchGroups, matchMembers, reconItems } from "../schema";

/** A side as the compiled SQL reads it: its source (and the source's space, maybe another one sharing it) and its whitelist. */
export type SideRef = { key: "a" | "b"; sourceSpaceId: string; sourceId: string; fields: ReadonlyMap<string, RecordField> };
/** Where a step works: the config's space, the run, live items (simRunId null) or a simulation's, the date window. */
export type StepCtx = {
  spaceId: string; configId: string; versionId: string; runId: string; simRunId: string | null;
  sides: readonly [SideRef, SideRef]; lo: string; hi: string;
  /** ingest's currentRecord over `records` (a record that counts now), built on the step's transaction. */
  current: SQL;
};

/** The amount with its sign (ingest's signedAmount): negated when the record's direction is a debit code. */
export const signedSql = (): SQL =>
  sql`(case when upper(btrim(${records.direction})) in (${sql.join(DEBIT_CODES.map((c) => sql`${c}`), sql`, `)}) then -${records.amountMinor} else ${records.amountMinor} end)`;

const CORE: Record<string, () => SQL> = {
  ext_ref: () => sql`${records.extRef}`, account_ref: () => sql`${records.accountRef}`, currency: () => sql`${records.currency}`,
  direction: () => sql`${records.direction}`, event_time: () => sql`${records.eventTime}`, business_date: () => sql`${records.businessDate}`,
  amount_minor: signedSql,
};
const CAST: Record<FieldKind, SQL> = { text: sql``, decimal: sql`::numeric`, date: sql`::date`, boolean: sql`::boolean` };

/** Field `ref` of side `s`'s records as SQL over `records`; refuses a field outside the side's whitelist. */
export function fieldSql(s: SideRef, ref: string): SQL {
  const f = s.fields.get(ref);
  if (!f) throw new Error(`engine: side ${s.key} has no field ${ref}`);
  if (Object.hasOwn(CORE, ref)) return CORE[ref]!();
  const name = ref.slice("attrs.".length);
  if (!ref.startsWith("attrs.") || !ATTR_NAME.test(name)) throw new Error(`engine: not a field: ${ref}`);
  return sql`(${records.attrs} ->> ${name})${CAST[f.kind]}`;
}

/** Equal after trim, upper case and dropping all but letters and digits (eq_normalized). */
const normalized = (x: SQL): SQL => sql`regexp_replace(upper(btrim(${x})), '[^A-Z0-9]', '', 'g')`;

/** A tolerance per currency (major units, decimal text) as minor units of each currency (ISO exponent, no float). */
export function minorTolerance(t: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(t).map(([code, v]) => {
    const [i, f = ""] = v.split(".");
    const m = toMinor(BigInt(i! + f), f.length, "major", CURRENCY_EXPONENT[code]!, code);
    if ("why" in m) throw new Error(`engine: tolerance ${code} ${v}: ${m.why}`);
    return [code, m.v.toString()];
  }));
}

/** The pass's field pairs in column order: its matching keys, then one per predicate (`x0`, `x1`, … in the pools). */
const pairsOf = (p: PassSpec) => [...p.blocking, ...p.predicates.map((q) => q.field)];
const col = (alias: "a" | "b", i: number) => sql.raw(`${alias}.x${i}`);
const isAmount = (p: Predicate) => ([0, 1] as const).every((i) => sideRef(p.field, i) === "amount_minor");
const usesTime = (p: Predicate) => ([0, 1] as const).some((i) => sideRef(p.field, i) === "event_time");

/** The largest difference `p` allows at a row of currency `ccy`: per currency, none = 0 (exact); minor units for the amount. */
function toleranceOf(p: Predicate & { tolerance: Record<string, string> }, ccy: SQL): SQL {
  const map = isAmount(p) ? minorTolerance(p.tolerance) : p.tolerance;
  return sql`coalesce((${JSON.stringify(map)}::text::jsonb ->> ${ccy})::numeric, 0)`;
}

/** What predicate `p` (column `i`) adds: a join equality, a filter, a signed delta for the evidence, a distance. */
export function predicateSql(p: Predicate, i: number): { join?: SQL; filter?: SQL; delta?: SQL; dist?: SQL } {
  const a = col("a", i), b = col("b", i);
  switch (p.op) {
    case "eq": case "eq_normalized": return { join: sql`${a} = ${b}` };
    case "amount_abs_tol": {
      const d = sql`(${b} - ${a})`;
      return { filter: sql`abs${d} <= ${toleranceOf(p, sql.raw("a.ccy"))}`, delta: d, dist: sql`abs${d}` };
    }
    case "amount_pct_tol": {
      const d = sql`(${b} - ${a})`;
      return { filter: sql`abs${d} * 100 <= ${p.percent}::numeric * greatest(abs(${a}), abs(${b}))`, delta: d, dist: sql`abs${d}` };
    }
    case "date_window": {
      const d = usesTime(p) ? sql`(extract(epoch from (${b}::timestamptz - ${a}::timestamptz)) / 86400)` : sql`(${b} - ${a})`;
      return { filter: sql`abs${d} <= ${p.days}`, delta: d, dist: sql`abs${d}` };
    }
    case "bday_window": {
      const d = sql`(b.bday - a.bday)`;
      return { filter: sql`abs${d} <= ${p.days}`, delta: d, dist: sql`abs${d}` };
    }
    case "contains": return { filter: sql`strpos(${a}, ${b}) > 0` };
    case "similarity": {
      const s = sql`similarity(${a}, ${b})`;
      return { filter: sql`${s} >= ${p.min}`, delta: s, dist: sql`(1 - ${s})` };
    }
    case "eq_sum": return {};
  }
}

/** Side `s`'s pool: its open items of the window with their records' fields, locked, skipping items held elsewhere. */
export function poolSql(c: StepCtx, p: PassSpec, s: 0 | 1): SQL {
  const side = c.sides[s];
  const xs = pairsOf(p).map((f, i) => {
    const x = fieldSql(side, sideRef(f, s));
    return sql`${p.predicates[i - p.blocking.length]?.op === "eq_normalized" ? normalized(x) : x} as ${sql.raw(`x${i}`)}`;
  });
  return sql`select i.id, i.version as v, i.business_date as bd, ${records.bdayIndex} as bday, ${records.currency} as ccy, ${signedSql()} as amt${xs.length ? sql`, ${sql.join(xs, sql`, `)}` : sql``}
    from ${reconItems} i join ${records} on ${records.spaceId} = ${side.sourceSpaceId} and ${records.sourceId} = ${side.sourceId}
      and ${records.id} = i.record_id and ${records.businessDate} = i.business_date and ${c.current}
    where i.space_id = ${c.spaceId} and i.config_id = ${c.configId} and i.side = ${side.key} and i.status = 'open'
      and ${c.simRunId === null ? sql`i.sim_run_id is null` : sql`i.sim_run_id = ${c.simRunId}`}
      and i.business_date between ${c.lo}::date and ${c.hi}::date
    for update of i skip locked`;
}

/** Joins, filters, deltas and distance of the pass's predicates (a group pass's eq_sum is judged on the group). */
function compiled(p: PassSpec) {
  const parts = p.predicates.map((q, j) => ({ q, j, ...predicateSql(q, p.blocking.length + j) }));
  const joins = [...p.blocking.map((_, i) => sql`${col("a", i)} = ${col("b", i)}`), ...parts.flatMap((x) => (x.join ? [x.join] : []))];
  const filters = parts.flatMap((x) => (x.filter ? [x.filter] : []));
  return { parts, on: joins.length ? sql.join(joins, sql` and `) : sql`true`, where: filters.length ? sql.join(filters, sql` and `) : sql`true` };
}

/** The pools and the candidate pairs (`c`): ids, versions, dates, signed amounts, a delta per predicate (d<j>), the distance. */
export function candidatesSql(c: StepCtx, p: PassSpec): SQL {
  const { parts, on, where } = compiled(p);
  const deltas = parts.map((x) => sql`${x.delta ?? sql`null::numeric`} as ${sql.raw(`d${x.j}`)}`);
  const dists = parts.flatMap((x) => (x.dist ? [x.dist] : []));
  const sum = p.cardinality === "1:1" ? sql`` : sql`, a.${sql.raw(`x${p.blocking.length + p.predicates.findIndex((q) => q.op === "eq_sum")}`)} as a_s, b.${sql.raw(`x${p.blocking.length + p.predicates.findIndex((q) => q.op === "eq_sum")}`)} as b_s`;
  return sql`pa as materialized (${poolSql(c, p, 0)}),
  pb as materialized (${poolSql(c, p, 1)}),
  c as materialized (select a.id as a_id, b.id as b_id, a.v as a_v, b.v as b_v, a.bd as a_bd, b.bd as b_bd, a.amt as a_amt, b.amt as b_amt,
      a.ccy as a_ccy, b.ccy as b_ccy${sum}, array[${sql.join(dists, sql`, `)}]::numeric[] as dist, ${sql.join(deltas, sql`, `)}
    from pa a join pb b on ${on} where ${where})`;
}

/** How a group was chosen, as its evidence says. */
export const CHOSEN = { unique: "mutual unique best", tie: "tie broken by earliest business date, then id", group: "group sum, one counterpart" } as const;

/** space_id, config_id, config_version_id, run_id of a group row, typed for an INSERT … SELECT. */
const ids = (c: StepCtx) => sql`${c.spaceId}::uuid, ${c.configId}::uuid, ${c.versionId}::uuid, ${c.runId}::uuid`;

/** A 1:1 group's evidence: the pass, the version and run, how it was chosen, and per predicate passed + delta (row `r`). */
function pairEvidence(c: StepCtx, p: PassSpec, chosen: string): SQL {
  const preds = p.predicates.map((q, j) =>
    sql`jsonb_build_object('op', ${q.op}::text, 'field', ${JSON.stringify(q.field)}::text::jsonb, 'passed', true, 'delta', r.${sql.raw(`d${j}`)})`);
  return sql`jsonb_build_object('pass', ${p.no}::int, 'name', ${p.name}::text, 'configVersionId', ${c.versionId}::text, 'runId', ${c.runId}::text,
    'chosen', ${chosen}::text, 'predicates', jsonb_build_array(${sql.join(preds, sql`, `)}))`;
}

/**
 * Writes the pairs of CTE `acc` (gid, a_*, b_*, d<j>) as groups of `kind`: both items claimed (open at the version read,
 * A1), a group dated at the later member's date, two members. Answers { groups, items }: items = 2 × groups unless an
 * item was claimed elsewhere (the caller then rolls the step back).
 */
function writePairs(c: StepCtx, p: PassSpec, kind: "auto" | "suggested", chosen: string): SQL {
  return sql`up as (update ${reconItems} i set status = ${kind === "auto" ? "matched" : "suggested"}, version = i.version + 1
      from (select a_id as id, a_v as v, a_bd as bd from acc union all select b_id, b_v, b_bd from acc) x
      where i.space_id = ${c.spaceId} and i.id = x.id and i.business_date = x.bd and i.status = 'open' and i.version = x.v returning i.id),
  g as (insert into ${matchGroups} (id, space_id, config_id, config_version_id, run_id, pass_no, kind, business_date, evidence)
      select r.gid, ${ids(c)}, ${p.no}::smallint, ${kind}::text, greatest(r.a_bd, r.b_bd), ${pairEvidence(c, p, chosen)} from acc r),
  m as (insert into ${matchMembers} (group_id, space_id, item_id, side, signed_amount)
      select gid, ${c.spaceId}::uuid, a_id, 'a', a_amt from acc union all select gid, ${c.spaceId}::uuid, b_id, 'b', b_amt from acc)
  select (select count(*) from acc)::int as groups, (select count(*) from up)::int as items`;
}

/** Each candidate with its side's smallest distance (best_a, best_b) and how many of its candidates share it (n_a, n_b). */
const RANKED = sql`r1 as (select c.*, min(dist) over (partition by a_id) as best_a, min(dist) over (partition by b_id) as best_b from c),
  r2 as (select r1.*, count(*) filter (where dist = best_a) over (partition by a_id) as n_a,
      count(*) filter (where dist = best_b) over (partition by b_id) as n_b from r1)`;

/** 1:1, the pass's own choice: the mutual unique best pairs, written as the pass accepts them (auto or suggested). */
export function acceptSql(c: StepCtx, p: PassSpec): SQL {
  return sql`with ${candidatesSql(c, p)},
  ${RANKED},
  acc as materialized (select uuidv7() as gid, r2.* from r2 where dist = best_a and dist = best_b and n_a = 1 and n_b = 1)
  , ${writePairs(c, p, p.accept === "auto" ? "auto" : "suggested", CHOSEN.unique)}`;
}

/**
 * 1:1, on_ambiguous = suggest, once no pair is mutual unique best: among pairs that are each other's best, the pair
 * where each is the other's first by (business date, id), suggested. Run until it writes none: each round takes at least
 * the pair of the earliest such item.
 */
export function tieSuggestSql(c: StepCtx, p: PassSpec): SQL {
  return sql`with ${candidatesSql(c, p)},
  ${RANKED},
  o as (select r2.*, row_number() over (partition by a_id order by b_bd, b_id) as fa, row_number() over (partition by b_id order by a_bd, a_id) as fb
    from r2 where dist = best_a and dist = best_b),
  acc as materialized (select uuidv7() as gid, o.* from o where fa = 1 and fb = 1)
  , ${writePairs(c, p, "suggested", CHOSEN.tie)}`;
}

/** A group pass's candidates by one-side item: `one` = the side of single items (N:1: B, 1:N: A). */
export function groupsSql(c: StepCtx, p: PassSpec): SQL {
  const [o, m] = p.cardinality === "N:1" ? (["b", "a"] as const) : (["a", "b"] as const);
  const f = (side: "a" | "b", x: string) => sql.raw(`${side}_${x}`);
  return sql`${candidatesSql(c, p)},
  cg as (select ${f(o, "id")} as o_id, ${f(o, "v")} as o_v, ${f(o, "bd")} as o_bd, ${f(o, "amt")} as o_amt, ${f(o, "ccy")} as o_ccy, ${f(o, "s")} as o_s,
      ${f(m, "id")} as m_id, ${f(m, "v")} as m_v, ${f(m, "bd")} as m_bd, ${f(m, "amt")} as m_amt, ${f(m, "s")} as m_s from c),
  cm as (select cg.*, count(*) over (partition by m_id) as m_n from cg),
  grp as (select o_id, o_v, o_bd, o_amt, o_ccy, o_s, sum(m_s) as s, count(*)::int as n, max(m_bd) as m_bd, bool_and(m_n = 1) as uniq
    from cm group by o_id, o_v, o_bd, o_amt, o_ccy, o_s)`;
}

/** 1:N / N:1: each one-side item whose many-side candidates are its alone and sum to its amount (eq_sum tolerance). */
export function groupAcceptSql(c: StepCtx, p: PassSpec): SQL {
  const sumP = p.predicates.find((q) => q.op === "eq_sum")! as Extract<Predicate, { op: "eq_sum" }>;
  const [one, many] = p.cardinality === "N:1" ? ["b", "a"] : ["a", "b"];
  const kind = p.accept === "auto" ? "auto" : "suggested";
  const preds = p.predicates.map((q) => q.op === "eq_sum"
    ? sql`jsonb_build_object('op', 'eq_sum', 'field', ${JSON.stringify(q.field)}::text::jsonb, 'passed', true, 'sum', r.s, 'one', r.o_s, 'delta', r.s - r.o_s, 'members', r.n)`
    : sql`jsonb_build_object('op', ${q.op}::text, 'field', ${JSON.stringify(q.field)}::text::jsonb, 'passed', true)`);
  const evidence = sql`jsonb_build_object('pass', ${p.no}::int, 'name', ${p.name}::text, 'configVersionId', ${c.versionId}::text, 'runId', ${c.runId}::text,
    'chosen', ${CHOSEN.group}::text, 'predicates', jsonb_build_array(${sql.join(preds, sql`, `)}))`;
  return sql`with ${groupsSql(c, p)},
  acc as materialized (select uuidv7() as gid, grp.* from grp where uniq and abs(s - o_s) <= ${toleranceOf(sumP, sql.raw("grp.o_ccy"))}),
  ms as (select acc.gid, cm.m_id, cm.m_v, cm.m_bd, cm.m_amt from cm join acc using (o_id)),
  up as (update ${reconItems} i set status = ${kind === "auto" ? "matched" : "suggested"}, version = i.version + 1
      from (select o_id as id, o_v as v, o_bd as bd from acc union all select m_id, m_v, m_bd from ms) x
      where i.space_id = ${c.spaceId} and i.id = x.id and i.business_date = x.bd and i.status = 'open' and i.version = x.v returning i.id),
  g as (insert into ${matchGroups} (id, space_id, config_id, config_version_id, run_id, pass_no, kind, business_date, evidence)
      select r.gid, ${ids(c)}, ${p.no}::smallint, ${kind}::text, greatest(r.o_bd, r.m_bd), ${evidence} from acc r),
  m as (insert into ${matchMembers} (group_id, space_id, item_id, side, signed_amount)
      select gid, ${c.spaceId}::uuid, o_id, ${one}::text, o_amt from acc union all select gid, ${c.spaceId}::uuid, m_id, ${many}::text, m_amt from ms)
  select (select count(*) from acc)::int as groups, (select count(*) from up)::int as items, (select count(*) from acc)::int + (select count(*) from ms)::int as members`;
}
