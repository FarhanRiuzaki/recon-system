// A pass of a recon spec compiled to one set-based statement per step (spec §10, spike S1). boundaries.test.ts
// allowlists modules/engine/sql/ as the one place the engine writes SQL by hand. Values (ids, dates, tolerances, the
// attribute names) are bound parameters; identifiers are fixed here: a core field maps to its `records` column through
// CORE below, an attribute is `records.attrs ->> $name` (bound; records has no promoted attribute columns yet, and the
// pass needs none: the pool is read through recon_items_open and the records primary key, and the candidate join is a
// hash join between the two pools), every field checked against the side's whitelist (recordFields of its published
// source version), operators only the closed list (spec §10).
//
// Shape of every statement (S1): two pools, side A's and side B's open items of the business-date window joined to
// their current records; each item marked `lk` when this statement could lock it (`for update skip locked` in a
// subselect: an item another transaction holds is seen, so it still competes, but never written, A1). Then the
// candidates (the pass's matching keys and equalities as the join, the other conditions as a filter, a distance per
// tolerance), a choice among all of them, and the writes as data-modifying CTEs for chosen pairs whose items are all
// locked: items claimed with `status = 'open' and version = v`, groups and members inserted. A step's statements run in
// one transaction.
//
// The choice, 1:1: a pair is taken when it is mutual unique best, each the other's only candidate at the smallest
// distance (lexicographic over the pass's tolerances in order). A pass of equalities only has no distance: a key held
// once on each side is its unique best pair, and a key held n times on both sides pairs in order (FIFO by the records'
// business date, event time, record id; never the item id, which intake makes, so a simulation pairs as live does).
// What is left is a tie, for on_ambiguous: break (breaks.ts) or suggest (tieSuggest, the same order). A group pass
// (1:N / N:1) groups the many side's candidates by its one-side item and compares the sum (eq_sum); a many-side item
// that two one-side items claim is ambiguous.
//
// Amounts: each side's signed amount (signedAmount's rule: a debit code negates), negated again for a side with
// amount_sign = negate, so the amounts compared (eq, tolerances, eq_sum) are on one sign convention and a match means
// side A's sum equals side B's. match_members.signed_amount keeps the record's own signed amount (`own`).
import type { Filter, PassSpec, Predicate } from "@starterkit/shared/contracts/recon";
import { ATTR_NAME, CURRENCY_EXPONENT, DEBIT_CODES, toMinor } from "@starterkit/shared/sources";
import { type FieldKind, type RecordField, sideRef } from "@starterkit/shared/recon";
import { type SQL, sql } from "drizzle-orm";
import { records } from "../../ingest";
import { matchGroups, matchMembers, reconItems } from "../schema";

/**
 * A side as the compiled SQL reads it: its source (and the source's space, maybe another one sharing it), its
 * whitelist, and whether its amounts are negated before they are compared (SideSpec.amount_sign).
 */
export type SideRef = {
  key: "a" | "b"; sourceSpaceId: string; sourceId: string; fields: ReadonlyMap<string, RecordField>; negate: boolean;
  /** A db_snapshot source: its records count from their snapshot's activation, not their seq, so intake keeps no mark. */
  snapshot: boolean;
};
/** Where a step works: the config's space, the run, live items (simRunId null) or a simulation's, the date window. */
export type StepCtx = {
  spaceId: string; configId: string; versionId: string; runId: string; simRunId: string | null;
  sides: readonly [SideRef, SideRef]; lo: string; hi: string;
  /** ingest's currentRecord over `records` (a record that counts now), built on the step's transaction. */
  current: SQL;
  /**
   * Carry over > 0: a suggesting pass that pairs an unmatch of the window leaves it unmatch with the pair proposed
   * (proposeSql, DEC-047), cleared once the pair is taken. An automatic pass that pairs an unmatch (the pool holds every
   * one, DEC-064) closes it as AUTO_MATCHED_LATE_DATA, whatever the carry over.
   */
  late: boolean;
  /** A one-way recon (direction a_to_b, DEC-055, DEC-062): a side-B item is never a break; without a pair it is not_required. */
  oneWay: boolean;
};

/** The record's own amount with its sign (ingest's signedAmount): negated when its direction is a debit code. */
export const signedSql = (): SQL =>
  sql`(case when upper(btrim(${records.direction})) in (${sql.join(DEBIT_CODES.map((c) => sql`${c}`), sql`, `)}) then -${records.amountMinor} else ${records.amountMinor} end)`;
/** The amount side `s` compares: its signed amount, negated for a side with amount_sign = negate. */
export const comparedAmount = (s: SideRef): SQL => (s.negate ? sql`(-${signedSql()})` : signedSql());

const CORE: Record<string, (s: SideRef) => SQL> = {
  ext_ref: () => sql`${records.extRef}`, account_ref: () => sql`${records.accountRef}`, currency: () => sql`${records.currency}`,
  direction: () => sql`${records.direction}`, event_time: () => sql`${records.eventTime}`, business_date: () => sql`${records.businessDate}`,
  amount_minor: comparedAmount,
};
const CAST: Record<FieldKind, SQL> = { text: sql``, decimal: sql`::numeric`, date: sql`::date`, boolean: sql`::boolean` };

/** Field `ref` of side `s`'s records as SQL over `records`; refuses a field outside the side's whitelist. */
export function fieldSql(s: SideRef, ref: string): SQL {
  const f = s.fields.get(ref);
  if (!f) throw new Error(`engine: side ${s.key} has no field ${ref}`);
  if (Object.hasOwn(CORE, ref)) return CORE[ref]!(s);
  const name = ref.slice("attrs.".length);
  if (!ref.startsWith("attrs.") || !ATTR_NAME.test(name)) throw new Error(`engine: not a field: ${ref}`);
  return sql`(${records.attrs} ->> ${name})${CAST[f.kind]}`;
}

/** A side filter, or a rule's condition, as SQL over `records` (closed operators, values bound and cast to the field's kind). */
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

/** Equal after trim, upper case and dropping all but letters and digits (eq_normalized); empty never matches. */
const normalized = (x: SQL): SQL => sql`nullif(regexp_replace(upper(btrim(${x})), '[^A-Z0-9]', '', 'g'), '')`;

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
/** A pass that compares by equality only: its candidates split by key, without a distance. */
export const equalitiesOnly = (p: PassSpec) => p.cardinality === "1:1" && p.predicates.every((q) => q.op === "eq" || q.op === "eq_normalized");

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

/**
 * The statuses of the pool (DEC-064): open, every unmatch whatever its reason (a run makes what stays unpaired unmatch
 * at once, and the next runs pair it again within carry over), and a one-way recon's not_required items (DEC-055) but
 * those still in a suggested group (side A's pair, DEC-062). An unmatch waiting for a decision (force match, write-off,
 * posting) stays out, a person is deciding it; so does every item of a signed-off date, the day is frozen (live only, a
 * simulation's own items are never signed off).
 */
const poolStatus = (_c: StepCtx): SQL => sql`(i.status = 'open' or (((i.status = 'break' and i.break_state is distinct from 'pending_approval')
      or (i.status = 'not_required' and not exists (select 1 from match_members sm
        join match_groups sgr on sgr.space_id = sm.space_id and sgr.id = sm.group_id and sgr.kind = 'suggested' and sgr.reversed_by is null
        where sm.space_id = i.space_id and sm.item_id = i.id)))
      and (i.sim_run_id is not null or not exists (select 1 from recon_days rd where rd.space_id = i.space_id and rd.config_id = i.config_id
        and rd.business_date = i.business_date and rd.signed_at is not null))))`;

/** Side `s`'s pool items of the window, live or of the step's simulation (the `i` alias of recon_items). */
const openItems = (c: StepCtx, s: 0 | 1): SQL => sql`i.space_id = ${c.spaceId} and i.config_id = ${c.configId} and i.side = ${c.sides[s].key} and ${poolStatus(c)}
      and ${c.simRunId === null ? sql`i.sim_run_id is null` : sql`i.sim_run_id = ${c.simRunId}`}
      and i.business_date between ${c.lo}::date and ${c.hi}::date`;

/**
 * Side `s`'s pool: every open item of the window with its record's fields, the order fields (bd, et, rid), its own
 * signed amount (own) and the compared one (amt), and `lk`: whether this statement locked it (`l<s>`, skip locked).
 * The items this statement locked (from `l<s>`, as they are now) and, apart, the open ones another transaction holds
 * (an anti join against `l<s>`), never a left join of every item to `l<s>`: planned on an underestimated join
 * (5 rows for 5,000), that one rescanned `l<s>` per item, 1 s a side for a tick of 5,000 (REC-P1).
 */
export function poolSql(c: StepCtx, p: PassSpec, s: 0 | 1): SQL {
  const side = c.sides[s];
  const xs = pairsOf(p).map((f, i) => {
    const x = fieldSql(side, sideRef(f, s));
    const op = p.predicates[i - p.blocking.length]?.op;
    return sql`${op === "eq_normalized" ? normalized(x) : op === "contains" ? sql`nullif(${x}, '')` : x} as ${sql.raw(`x${i}`)}`;
  });
  const lock = sql.raw(`l${s}`);
  return sql`select i.id, i.v, i.lk, i.st, i.bd, ${records.eventTime} as et, ${records.id} as rid,
      ${records.bdayIndex} as bday, ${records.currency} as ccy, ${signedSql()} as own, ${comparedAmount(side)} as amt${xs.length ? sql`, ${sql.join(xs, sql`, `)}` : sql``}
    from (select l.id, l.v, true as lk, l.st, l.bd, l.rec from ${lock} l
      union all select i.id, i.version, false, i.status, i.business_date, i.record_id from ${reconItems} i
        where ${openItems(c, s)} and not exists (select 1 from ${lock} l where l.id = i.id)) i
    join ${records} on ${records.spaceId} = ${side.sourceSpaceId} and ${records.sourceId} = ${side.sourceId}
      and ${records.id} = i.rec and ${records.businessDate} = i.bd and ${c.current}`;
}

/** Joins, filters, deltas and distance of the pass's predicates (a group pass's eq_sum is judged on the group). */
function compiled(p: PassSpec) {
  const parts = p.predicates.map((q, j) => ({ q, j, ...predicateSql(q, p.blocking.length + j) }));
  const joins = [...p.blocking.map((_, i) => sql`${col("a", i)} = ${col("b", i)}`), ...parts.flatMap((x) => (x.join ? [x.join] : []))];
  const filters = parts.flatMap((x) => (x.filter ? [x.filter] : []));
  return { parts, on: joins.length ? sql.join(joins, sql` and `) : sql`true`, where: filters.length ? sql.join(filters, sql` and `) : sql`true` };
}

/**
 * The locks, pools and candidate pairs (`c`): per side id, version, lk, order fields, amounts and currency; a delta per
 * predicate (d<j>) and the distance; a group pass's summed field (a_s, b_s).
 */
export function candidatesSql(c: StepCtx, p: PassSpec): SQL {
  const { parts, on, where } = compiled(p);
  const deltas = parts.map((x) => sql`${x.delta ?? sql`null::numeric`} as ${sql.raw(`d${x.j}`)}`);
  const dists = parts.flatMap((x) => (x.dist ? [x.dist] : []));
  const sumCol = `x${p.blocking.length + p.predicates.findIndex((q) => q.op === "eq_sum")}`;
  const sum = p.cardinality === "1:1" ? sql`` : sql`, a.${sql.raw(sumCol)} as a_s, b.${sql.raw(sumCol)} as b_s`;
  const side = (x: "a" | "b") => sql.raw(["id", "v", "lk", "st", "bd", "et", "rid", "own", "amt", "ccy"].map((k) => `${x}.${k} as ${x}_${k}`).join(", "));
  const lock = (s: 0 | 1) => sql`select i.id, i.version as v, i.status as st, i.business_date as bd, i.record_id as rec from ${reconItems} i where ${openItems(c, s)} for update skip locked`;
  return sql`l0 as materialized (${lock(0)}),
  l1 as materialized (${lock(1)}),
  pa as materialized (${poolSql(c, p, 0)}),
  pb as materialized (${poolSql(c, p, 1)}),
  c as materialized (select ${side("a")}, ${side("b")}${sum}, array[${sql.join(dists, sql`, `)}]::numeric[] as dist, ${sql.join(deltas, sql`, `)}
    from pa a join pb b on ${on} where ${where})`;
}

/** How a group was chosen, as its evidence says. */
export const CHOSEN = {
  unique: "mutual unique best", fifo: "duplicates paired in order: business date, event time, record id",
  tie: "tie broken by business date, event time, record id", group: "group sum, one counterpart", rule: "rule met, no counterpart",
} as const;
/** The deterministic order of a side's items among equals: the record's business date, event time, id. */
const order = (x: "a" | "b") => sql.raw(`${x}_bd, ${x}_et, ${x}_rid`);

/** space_id, config_id, config_version_id, run_id, sim_run_id of a group row, typed for an INSERT … SELECT. */
const ids = (c: StepCtx) => sql`${c.spaceId}::uuid, ${c.configId}::uuid, ${c.versionId}::uuid, ${c.runId}::uuid, ${c.simRunId}::uuid`;
const GROUP_COLS = sql`(id, space_id, config_id, config_version_id, run_id, sim_run_id, pass_no, kind, business_date, evidence)`;

/** A 1:1 group's evidence: the pass, the version and run, how it was chosen, and per predicate passed + delta (row `r`). */
function pairEvidence(c: StepCtx, p: PassSpec, chosen: SQL): SQL {
  const preds = p.predicates.map((q, j) =>
    sql`jsonb_build_object('op', ${q.op}::text, 'field', ${JSON.stringify(q.field)}::text::jsonb, 'passed', true, 'delta', r.${sql.raw(`d${j}`)})`);
  return sql`jsonb_build_object('pass', ${p.no}::int, 'name', ${p.name}::text, 'configVersionId', ${c.versionId}::text, 'runId', ${c.runId}::text,
    'chosen', ${chosen}, 'predicates', jsonb_build_array(${sql.join(preds, sql`, `)}))`;
}

/**
 * Claims the items of `from` (id, v, st, bd, as `x`) for `status`: each at the status and version read (A1); a break it
 * pairs closes as late data, resolved now (its queue state and time, as a person's resolution writes them: the
 * dashboard's Resolved median counts it, I2).
 */
const claim = (c: StepCtx, status: string, from: SQL): SQL => sql`update ${reconItems} i set status = ${status}, version = i.version + 1,
      resolution = case when x.st = 'break' then ${LATE_DATA} else i.resolution end,
      break_state = case when x.st = 'break' then 'resolved' else i.break_state end,
      state_at = case when x.st = 'break' then now() else i.state_at end
      from (${from}) x where i.space_id = ${c.spaceId} and i.id = x.id and i.business_date = x.bd and i.status = x.st and i.version = x.v returning i.id, i.business_date as bd`;
/**
 * The business dates CTE `cte` (a column `bd`) changed, comma-joined (null for none), as column `dates`: a run queues
 * their dashboard rollup (stats.ts), also for the carry-over dates before its own.
 */
export const datesOf = (cte: string): SQL => sql.raw(`(select string_agg(distinct ${cte}.bd::text, ',') from ${cte}) as dates`);
/** Answers of a statement that names the dates it changed (datesOf). */
export type Dated = { dates: string | null };

/** The resolution of a break a late counterpart closed (spec §11, DEC-043). */
export const LATE_DATA = "AUTO_MATCHED_LATE_DATA";

/**
 * Writes the pairs of CTE `acc` (gid, a_*, b_*, d<j>; all locked) as groups of `kind`: both items claimed (at the
 * status and version read, A1), a group dated at the later member's date, two members with the records' own signed
 * amounts. A suggestion takes open and not_required items only (a break waits for an automatic match or a person). Answers { groups,
 * items }: items = 2 × groups, else the caller rolls the step back.
 */
function writePairs(c: StepCtx, p: PassSpec, kind: "auto" | "suggested", chosen: SQL): SQL {
  return sql`ok as (select * from acc${kind === "suggested" ? sql` where a_st in ('open', 'not_required') and b_st in ('open', 'not_required')` : sql``}),
  up as (${claim(c, kind === "auto" ? "matched" : "suggested", sql`select a_id as id, a_v as v, a_st as st, a_bd as bd from ok union all select b_id, b_v, b_st, b_bd from ok`)}),
  g as (insert into ${matchGroups} ${GROUP_COLS}
      select r.gid, ${ids(c)}, ${p.no}::smallint, ${kind}::text, greatest(r.a_bd, r.b_bd), ${pairEvidence(c, p, chosen)} from ok r),
  m as (insert into ${matchMembers} (group_id, space_id, item_id, side, signed_amount)
      select gid, ${c.spaceId}::uuid, a_id, 'a', a_own from ok union all select gid, ${c.spaceId}::uuid, b_id, 'b', b_own from ok)
  select (select count(*) from ok)::int as groups, (select count(*) from up)::int as items, ${datesOf("up")}`;
}
const accepted = (p: PassSpec) => (p.accept === "auto" ? "auto" : "suggested");

/** Each candidate with its side's smallest distance (best_a, best_b) and how many of its candidates share it (n_a, n_b). */
export const RANKED = sql`r1 as (select c.*, min(dist) over (partition by a_id) as best_a, min(dist) over (partition by b_id) as best_b from c),
  r2 as (select r1.*, count(*) filter (where dist = best_a) over (partition by a_id) as n_a,
      count(*) filter (where dist = best_b) over (partition by b_id) as n_b from r1)`;

/** 1:1 with a distance: the mutual unique best pairs whose items are both locked, written as the pass accepts them. */
export function acceptSql(c: StepCtx, p: PassSpec): SQL {
  return sql`with ${candidatesSql(c, p)},
  ${RANKED},
  acc as materialized (select uuidv7() as gid, r2.* from r2 where dist = best_a and dist = best_b and n_a = 1 and n_b = 1 and a_lk and b_lk),
  ${writePairs(c, p, accepted(p), sql`${CHOSEN.unique}::text`)}`;
}

/**
 * 1:1 of equalities only: per key (a candidate's partners are its key's other side, all of them), as many items on
 * both sides → the i-th of A with the i-th of B in record order (one each: the unique best pair). Only keys whose items
 * are all locked; a key with unequal counts is left to on_ambiguous.
 */
export function fifoSql(c: StepCtx, p: PassSpec): SQL {
  return sql`with ${candidatesSql(c, p)},
  r as (select c.*, count(*) over (partition by b_id) as na, count(*) over (partition by a_id) as nb,
      row_number() over (partition by b_id order by ${order("a")}) as ra, row_number() over (partition by a_id order by ${order("b")}) as rb,
      bool_and(a_lk and b_lk) over (partition by a_id) as all_a, bool_and(a_lk and b_lk) over (partition by b_id) as all_b from c),
  acc as materialized (select uuidv7() as gid, r.* from r where na = nb and ra = rb and all_a and all_b),
  ${writePairs(c, p, accepted(p), sql`(case when r.na = 1 then ${CHOSEN.unique}::text else ${CHOSEN.fifo}::text end)`)}`;
}

/**
 * 1:1, on_ambiguous = suggest, once no pair is taken: among pairs that are each other's best, the pair where each is
 * the other's first in record order, both locked, suggested. Run until it writes none: each round takes at least the
 * pair of the earliest locked item that has one.
 */
export function tieSuggestSql(c: StepCtx, p: PassSpec): SQL {
  return sql`with ${candidatesSql(c, p)},
  ${RANKED},
  o as (select r2.*, row_number() over (partition by a_id order by ${order("b")}) as fa, row_number() over (partition by b_id order by ${order("a")}) as fb
    from r2 where dist = best_a and dist = best_b),
  acc as materialized (select uuidv7() as gid, o.* from o where fa = 1 and fb = 1 and a_lk and b_lk),
  ${writePairs(c, p, "suggested", sql`${CHOSEN.tie}::text`)}`;
}

/**
 * 1:1, a pass that suggests (accept or on_ambiguous suggest), after its own pairs: the pairs it would suggest (each
 * the other's best and first in record order, as tieSuggestSql) where a member is a break (DEC-047). The break stays
 * a break; its proposed pair and this pass are written on it (proposed_item_id, proposed_pass, version + 1), when they
 * change and no earlier pass proposed one (an earlier pass's proposal stands). The open member stays open for later
 * passes and its own day close. Answers { n } breaks given a proposal.
 */
export function proposeSql(c: StepCtx, p: PassSpec): SQL {
  return sql`with ${candidatesSql(c, p)},
  ${RANKED},
  o as (select r2.*, row_number() over (partition by a_id order by ${order("b")}) as fa, row_number() over (partition by b_id order by ${order("a")}) as fb
    from r2 where dist = best_a and dist = best_b),
  pr as (select a_id as id, a_v as v, a_bd as bd, b_id as other from o where fa = 1 and fb = 1 and a_lk and b_lk and a_st = 'break'
    union all select b_id, b_v, b_bd, a_id from o where fa = 1 and fb = 1 and a_lk and b_lk and b_st = 'break'),
  up as (update ${reconItems} i set proposed_item_id = pr.other, proposed_pass = ${p.no}::smallint, version = i.version + 1
    from pr where i.space_id = ${c.spaceId} and i.id = pr.id and i.business_date = pr.bd and i.status = 'break' and i.version = pr.v
      and (i.proposed_pass is null or i.proposed_pass >= ${p.no}::smallint)
      and (i.proposed_item_id is distinct from pr.other or i.proposed_pass is distinct from ${p.no}::smallint) returning i.business_date as bd)
  select (select count(*) from up)::int as n, ${datesOf("up")}`;
}

/**
 * Clears the proposals (proposeSql) of the window's breaks whose proposed item was paired since (matched, suggested
 * or closed elsewhere): a stale pair is no one-click resolution. Breaks this statement can lock only (A1). Answers { n }.
 */
export function clearProposalsSql(c: StepCtx): SQL {
  return sql`with x as (select b.id, b.business_date as bd from ${reconItems} b
      where b.space_id = ${c.spaceId} and b.config_id = ${c.configId} and ${c.simRunId === null ? sql`b.sim_run_id is null` : sql`b.sim_run_id = ${c.simRunId}`}
        and b.business_date between ${c.lo}::date and ${c.hi}::date and b.status = 'break' and b.proposed_item_id is not null
        and exists (select 1 from ${reconItems} p where p.space_id = b.space_id and p.config_id = b.config_id and p.id = b.proposed_item_id
          and p.status in ('matched', 'suggested', 'closed'))
      for update of b skip locked),
  up as (update ${reconItems} i set proposed_item_id = null, proposed_pass = null, version = i.version + 1
    from x where i.space_id = ${c.spaceId} and i.id = x.id and i.business_date = x.bd returning i.business_date as bd)
  select (select count(*) from up)::int as n, ${datesOf("up")}`;
}

/** A group pass's candidates by one-side item: `one` = the side of single items (N:1: B, 1:N: A). */
export function groupsSql(c: StepCtx, p: PassSpec): SQL {
  const [o, m] = p.cardinality === "N:1" ? (["b", "a"] as const) : (["a", "b"] as const);
  const f = (side: "a" | "b", x: string, as: string) => sql.raw(`${side}_${x} as ${as}`);
  const cols = (side: "a" | "b", pre: string) => sql.join(["id", "v", "lk", "st", "bd", "own", "s"].map((x) => f(side, x, `${pre}_${x}`)), sql`, `);
  return sql`${candidatesSql(c, p)},
  cg as (select ${cols(o, "o")}, ${f(o, "ccy", "o_ccy")}, ${cols(m, "m")} from c),
  cm as (select cg.*, count(*) over (partition by m_id) as m_n from cg),
  grp as (select o_id, o_v, o_lk, o_st, o_bd, o_own, o_ccy, o_s, sum(m_s) as s, count(*)::int as n, max(m_bd) as m_bd,
      bool_and(m_n = 1) as uniq, bool_and(m_lk) and o_lk as all_lk
    from cm group by o_id, o_v, o_lk, o_st, o_bd, o_own, o_ccy, o_s)`;
}

/**
 * 1:N / N:1: each one-side item whose many-side candidates are its alone, all locked, summing to its amount (eq_sum
 * tolerance; side A's sum equals side B's).
 */
export function groupAcceptSql(c: StepCtx, p: PassSpec): SQL {
  const sumP = p.predicates.find((q) => q.op === "eq_sum")! as Extract<Predicate, { op: "eq_sum" }>;
  const [one, many] = p.cardinality === "N:1" ? ["b", "a"] : ["a", "b"];
  const kind = accepted(p);
  const preds = p.predicates.map((q) => q.op === "eq_sum"
    ? sql`jsonb_build_object('op', 'eq_sum', 'field', ${JSON.stringify(q.field)}::text::jsonb, 'passed', true, 'sum', r.s, 'one', r.o_s, 'delta', r.s - r.o_s, 'members', r.n)`
    : sql`jsonb_build_object('op', ${q.op}::text, 'field', ${JSON.stringify(q.field)}::text::jsonb, 'passed', true)`);
  const evidence = sql`jsonb_build_object('pass', ${p.no}::int, 'name', ${p.name}::text, 'configVersionId', ${c.versionId}::text, 'runId', ${c.runId}::text,
    'chosen', ${CHOSEN.group}::text, 'predicates', jsonb_build_array(${sql.join(preds, sql`, `)}))`;
  return sql`with ${groupsSql(c, p)},
  acc as materialized (select uuidv7() as gid, grp.* from grp where uniq and all_lk and abs(s - o_s) <= ${toleranceOf(sumP, sql.raw("grp.o_ccy"))}),
  ms as (select acc.gid, cm.m_id, cm.m_v, cm.m_st, cm.m_bd, cm.m_own from cm join acc using (o_id)),
  up as (${claim(c, kind === "auto" ? "matched" : "suggested", sql`select o_id as id, o_v as v, o_st as st, o_bd as bd from acc union all select m_id, m_v, m_st, m_bd from ms`)}),
  g as (insert into ${matchGroups} ${GROUP_COLS}
      select r.gid, ${ids(c)}, ${p.no}::smallint, ${kind}::text, greatest(r.o_bd, r.m_bd), ${evidence} from acc r),
  m as (insert into ${matchMembers} (group_id, space_id, item_id, side, signed_amount)
      select gid, ${c.spaceId}::uuid, o_id, ${one}::text, o_own from acc union all select gid, ${c.spaceId}::uuid, m_id, ${many}::text, m_own from ms)
  select (select count(*) from acc)::int as groups, (select count(*) from up)::int as items, (select count(*) from acc)::int + (select count(*) from ms)::int as members, ${datesOf("up")}`;
}

/**
 * A rule pass (1:0, owner 25 Nov: "side A amount = 0 is a match"): every pool item of its side (open, and with carry
 * over the late "No counterpart" breaks and not required items, as every pass's pool) whose current record meets each
 * condition (filterSql, the side filters' operators) is matched alone: claimed (A1: locked by this statement, at the
 * status and version read), a group of its own dated at its date, one member. The evidence names the rule and each
 * condition. Answers { groups, items } with items = groups, else the caller rolls the step back.
 */
export function ruleSql(c: StepCtx, p: PassSpec): SQL {
  const s = p.side === "b" ? 1 : 0;
  const side = c.sides[s];
  const conds = (p.when ?? []).map((f) => filterSql(side, f));
  const shown = (p.when ?? []).map((f) => sql`jsonb_build_object('op', ${f.op}::text, 'field', ${f.field}::text, 'value', ${"value" in f ? f.value : "values" in f ? f.values.join(", ") : null}::text, 'passed', true)`);
  const evidence = sql`jsonb_build_object('pass', ${p.no}::int, 'name', ${p.name}::text, 'configVersionId', ${c.versionId}::text, 'runId', ${c.runId}::text,
    'chosen', ${CHOSEN.rule}::text, 'side', ${side.key}::text, 'predicates', jsonb_build_array(), 'rule', jsonb_build_array(${sql.join(shown, sql`, `)}))`;
  return sql`with l as materialized (select i.id, i.version as v, i.status as st, i.business_date as bd, i.record_id as rec from ${reconItems} i
      where ${openItems(c, s)} for update skip locked),
  acc as materialized (select uuidv7() as gid, l.id, l.v, l.st, l.bd, ${signedSql()} as own from l
    join ${records} on ${records.spaceId} = ${side.sourceSpaceId} and ${records.sourceId} = ${side.sourceId}
      and ${records.id} = l.rec and ${records.businessDate} = l.bd and ${c.current}
    where ${sql.join(conds, sql` and `)}),
  up as (${claim(c, "matched", sql`select id, v, st, bd from acc`)}),
  g as (insert into ${matchGroups} ${GROUP_COLS}
      select r.gid, ${ids(c)}, ${p.no}::smallint, 'auto'::text, r.bd, ${evidence} from acc r),
  m as (insert into ${matchMembers} (group_id, space_id, item_id, side, signed_amount)
      select gid, ${c.spaceId}::uuid, id, ${side.key}::text, own from acc)
  select (select count(*) from acc)::int as groups, (select count(*) from up)::int as items, ${datesOf("up")}`;
}
