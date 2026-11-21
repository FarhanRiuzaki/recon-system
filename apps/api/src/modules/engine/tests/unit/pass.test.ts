// The SQL the engine compiles, pinned: each closed operator's fragment (spec §10), the fields (core columns, attributes
// bound, the side's whitelist), the signed amount (ingest's signedAmount rule), the side filters and the clauses every
// statement relies on (locked pools, the mutual unique best choice, the guarded claim).
import { describe, expect, it } from "bun:test";
import type { PassSpec, Predicate } from "@starterkit/shared/contracts/recon";
import { DEBIT_CODES } from "@starterkit/shared/sources";
import { type SQL, sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { signedAmount } from "../../../ingest";
import { breakReason, NEAR_MISS, tieBreakSql } from "../../sql/breaks";
import { closeReplacedSql, filterSql, intakeSql } from "../../sql/intake";
import { acceptSql, fieldSql, fifoSql, groupAcceptSql, minorTolerance, poolSql, predicateSql, type SideRef, type StepCtx, tieSuggestSql } from "../../sql/pass";

const dialect = new PgDialect();
const q = (x: SQL | undefined) => (x ? dialect.sqlToQuery(x) : undefined);
const text = (x: SQL) => dialect.sqlToQuery(x).sql.replace(/\s+/g, " ");
const parts = (o: ReturnType<typeof predicateSql>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, q(v)?.sql]));
const params = (o: ReturnType<typeof predicateSql>) => Object.values(o).flatMap((v) => q(v)!.params);

const side = (key: "a" | "b", negate = false): SideRef => ({
  key, negate, snapshot: false, sourceSpaceId: "00000000-0000-7000-8000-00000000000a", sourceId: "00000000-0000-7000-8000-00000000000b",
  fields: new Map([
    ["ext_ref", { kind: "text", from: "ref", fromType: "string" }], ["amount_minor", { kind: "decimal", from: "amt", fromType: "integer" }],
    ["currency", { kind: "text", from: "ccy", fromType: "string" }], ["business_date", { kind: "date", from: "d", fromType: "date" }],
    ["event_time", { kind: "date", from: "t", fromType: "datetime" }], ["direction", { kind: "text", from: "dir", fromType: "string" }],
    ["attrs.sid", { kind: "text", from: "sid", fromType: "string" }], ["attrs.qty", { kind: "decimal", from: "qty", fromType: "decimal" }],
  ]),
});
const ctx: StepCtx = {
  spaceId: "s", configId: "c", versionId: "v", runId: "r", simRunId: null, sides: [side("a"), side("b")], lo: "2026-11-01", hi: "2026-11-02", current: sql`true`, late: false,
};
const pass = (o: Partial<PassSpec> & { predicates: Predicate[] }): PassSpec => ({ no: 2, name: "P", cardinality: "1:1", blocking: [], accept: "suggest", on_ambiguous: "suggest", ...o });

describe("each operator's fragment (column x1 = side A's and side B's field of the predicate)", () => {
  it("eq and eq_normalized join on equality (eq_normalized's pool column is normalized)", () => {
    expect(parts(predicateSql({ op: "eq", field: "ext_ref" }, 1))).toEqual({ join: "a.x1 = b.x1" });
    expect(parts(predicateSql({ op: "eq_normalized", field: "ext_ref" }, 1))).toEqual({ join: "a.x1 = b.x1" });
  });

  it("amount_abs_tol: within the row currency's tolerance in minor units (ISO exponent), none = exact", () => {
    const p = predicateSql({ op: "amount_abs_tol", field: "amount_minor", tolerance: { IDR: "1000.00", JPY: "5", KWD: "1.5" } }, 1);
    expect(parts(p)).toEqual({ filter: "abs(b.x1 - a.x1) <= coalesce(($1::text::jsonb ->> a.ccy)::numeric, 0)", delta: "(b.x1 - a.x1)", dist: "abs(b.x1 - a.x1)" });
    expect(params(p)).toEqual(['{"IDR":"100000","JPY":"5","KWD":"1500"}']);
    // a decimal attribute is compared as it is (major units, no currency scale)
    expect(params(predicateSql({ op: "amount_abs_tol", field: "attrs.qty", tolerance: { IDR: "0.5" } }, 1))).toEqual(['{"IDR":"0.5"}']);
  });

  it("amount_pct_tol: |B − A| × 100 ≤ percent × the larger amount, in numeric", () => {
    const p = predicateSql({ op: "amount_pct_tol", field: "amount_minor", percent: "0.5" }, 1);
    expect(parts(p)).toEqual({ filter: "abs(b.x1 - a.x1) * 100 <= $1::numeric * greatest(abs(a.x1), abs(b.x1))", delta: "(b.x1 - a.x1)", dist: "abs(b.x1 - a.x1)" });
    expect(params(p)).toEqual(["0.5"]);
  });

  it("date_window: days between dates; between times through epoch seconds", () => {
    const d = predicateSql({ op: "date_window", field: "business_date", days: 1 }, 1);
    expect(parts(d)).toEqual({ filter: "abs(b.x1 - a.x1) <= $1", delta: "(b.x1 - a.x1)", dist: "abs(b.x1 - a.x1)" });
    expect(params(d)).toEqual([1]);
    expect(parts(predicateSql({ op: "date_window", field: "event_time", days: 2 }, 1)).filter)
      .toBe("abs(extract(epoch from (b.x1::timestamptz - a.x1::timestamptz)) / 86400) <= $1");
  });

  it("bday_window: business day indexes of the records' calendars", () => {
    expect(parts(predicateSql({ op: "bday_window", field: "business_date", days: 1 }, 1))).toEqual({ filter: "abs(b.bday - a.bday) <= $1", delta: "(b.bday - a.bday)", dist: "abs(b.bday - a.bday)" });
  });

  it("contains, similarity, and eq_sum (judged on the group, nothing per pair)", () => {
    expect(parts(predicateSql({ op: "contains", field: "ext_ref" }, 1))).toEqual({ filter: "strpos(a.x1, b.x1) > 0" });
    const s = predicateSql({ op: "similarity", field: "ext_ref", min: 0.6 }, 1);
    expect(parts(s)).toEqual({ filter: "similarity(a.x1, b.x1) >= $1", delta: "similarity(a.x1, b.x1)", dist: "(1 - similarity(a.x1, b.x1))" });
    expect(params(s)).toEqual([0.6]);
    expect(predicateSql({ op: "eq_sum", field: "amount_minor", tolerance: {} }, 1)).toEqual({});
  });
});

describe("fields", () => {
  it("a core field is its records column, an attribute a bound key cast to its kind; the amount is signed", () => {
    expect(q(fieldSql(side("a"), "ext_ref"))).toEqual({ sql: '"records"."ext_ref"', params: [] });
    expect(q(fieldSql(side("a"), "attrs.sid"))).toMatchObject({ sql: '("records"."attrs" ->> $1)', params: ["sid"] });
    expect(q(fieldSql(side("a"), "attrs.qty"))).toMatchObject({ sql: '("records"."attrs" ->> $1)::numeric', params: ["qty"] });
    expect(q(fieldSql(side("a"), "amount_minor"))).toMatchObject({
      sql: '(case when upper(btrim("records"."direction")) in ($1, $2, $3, $4, $5) then -"records"."amount_minor" else "records"."amount_minor" end)',
      params: ["D", "DR", "DB", "DEBIT", "DEBET"],
    });
  });

  it("the SQL's debit codes are signedAmount's: each negates, a credit code does not", () => {
    for (const c of [...DEBIT_CODES, "debit", " dr "]) expect(signedAmount({ amount_minor: 5n, direction: c })).toBe(-5n);
    for (const c of ["C", "CR", "K", "credit"]) expect(signedAmount({ amount_minor: 5n, direction: c })).toBe(5n);
    expect(DEBIT_CODES.every((c) => c === c.trim().toUpperCase())).toBe(true);
  });

  it("refuses a field outside the side's whitelist and anything that is not a field", () => {
    expect(() => fieldSql(side("a"), "account_ref")).toThrow("engine: side a has no field account_ref");
    expect(() => fieldSql({ ...side("a"), fields: new Map([["attrs.x; drop", { kind: "text", from: null, fromType: null }]]) }, "attrs.x; drop")).toThrow("engine: not a field");
  });

  it("a tolerance in major units becomes minor units of its currency, never rounded", () => {
    expect(minorTolerance({ IDR: "1000.00", USD: "0.01", JPY: "100", KWD: "0.125" })).toEqual({ IDR: "100000", USD: "1", JPY: "100", KWD: "125" });
    expect(() => minorTolerance({ JPY: "0.5" })).toThrow("JPY allows 0");
  });
});

describe("side filters (values bound, cast to the field's kind)", () => {
  const f = (x: Parameters<typeof filterSql>[1]) => q(filterSql(side("a"), x));
  it("every filter operator", () => {
    expect(f({ field: "direction", op: "eq", value: "debit" })).toMatchObject({ sql: '"records"."direction" = $1', params: ["debit"] });
    expect(f({ field: "business_date", op: "ne", value: "2026-11-02" })).toMatchObject({ sql: '"records"."business_date" is distinct from $1::date', params: ["2026-11-02"] });
    expect(f({ field: "attrs.sid", op: "in", values: ["X", "Y"] })).toMatchObject({ sql: '("records"."attrs" ->> $1) in ($2, $3)', params: ["sid", "X", "Y"] });
    expect(f({ field: "ext_ref", op: "not_in", values: ["X"] })!.sql).toBe('("records"."ext_ref" is null or "records"."ext_ref" not in ($1))');
    expect(f({ field: "ext_ref", op: "is_null" })!.sql).toBe('"records"."ext_ref" is null');
    expect(f({ field: "ext_ref", op: "not_null" })!.sql).toBe('"records"."ext_ref" is not null');
  });
});

describe("statements", () => {
  const p2 = pass({ blocking: ["ext_ref"], predicates: [{ op: "amount_abs_tol", field: "amount_minor", tolerance: { IDR: "1000.00" } }, { op: "eq", field: "currency" }] });

  it("pools: every open item of the window, live or one simulation's; lk = locked by this statement, skipping those held elsewhere", () => {
    const s = text(acceptSql(ctx, p2));
    expect(s).toContain("i.status = 'open' and i.sim_run_id is null and i.business_date between $");
    expect(s).toContain("with l0 as materialized (select i.id, i.version as v, i.status as st, i.business_date as bd, i.record_id as rec from \"recon_items\" i where i.space_id = $1");
    expect(s).toContain("for update skip locked), l1 as materialized");
    // the locked items as locked, then the held ones (anti join), each joined to its record
    expect(s).toContain("from (select l.id, l.v, true as lk, l.st, l.bd, l.rec from l0 l union all select i.id, i.version, false, i.status, i.business_date, i.record_id from \"recon_items\" i");
    expect(s).toContain("and not exists (select 1 from l0 l where l.id = i.id)) i join \"records\"");
    expect(s).not.toContain("left join l0");
    expect(s).not.toContain("for update of i");
    expect(s).toContain("from pa a join pb b on a.x0 = b.x0 and a.x2 = b.x2 where abs(b.x1 - a.x1) <=");
    expect(text(acceptSql({ ...ctx, simRunId: "sim" }, p2))).toContain("and i.sim_run_id = $");
    // carry over > 0: the breaks a late counterpart may close join the pool (Task 6)
    const late = acceptSql({ ...ctx, late: true }, p2);
    expect(text(late)).toContain("and (i.status = 'open' or (i.status = 'break' and i.late_match and i.break_reason = $");
    // only "No counterpart" breaks rejoin across days (DEC-047, Captain): the bound reason is the classifier's
    expect(dialect.sqlToQuery(late).params).toContain(NEAR_MISS.none);
  });

  it("accept: mutual unique best only; the claim is guarded by state and version; the group dated at its later member", () => {
    const s = text(acceptSql(ctx, p2));
    expect(s).toContain("where dist = best_a and dist = best_b and n_a = 1 and n_b = 1 and a_lk and b_lk");
    expect(s).toContain("count(*) filter (where dist = best_a) over (partition by a_id) as n_a");
    expect(s).toContain("i.status = x.st and i.version = x.v returning i.id");
    expect(s).toContain("resolution = case when x.st = 'break' then $");
    // a suggestion takes open items only; an automatic match may close a break as late data
    expect(s).toContain("ok as (select * from acc where a_st = 'open' and b_st = 'open')");
    expect(text(acceptSql(ctx, { ...p2, accept: "auto" }))).toContain("ok as (select * from acc)");
    expect(s).toContain("greatest(r.a_bd, r.b_bd)");
    expect(s).toContain("array[abs(b.x1 - a.x1)]::numeric[] as dist");
  });

  it("equalities only: per key, as many on both sides → paired in record order, all of the key locked", () => {
    const s = text(fifoSql(ctx, pass({ predicates: [{ op: "eq", field: "ext_ref" }] })));
    expect(s).toContain("count(*) over (partition by b_id) as na, count(*) over (partition by a_id) as nb");
    expect(s).toContain("row_number() over (partition by b_id order by a_bd, a_et, a_rid) as ra, row_number() over (partition by a_id order by b_bd, b_et, b_rid) as rb");
    expect(s).toContain("where na = nb and ra = rb and all_a and all_b");
  });

  it("ties: suggested in record order (never the item id), or broken as Duplicate (Ambiguous without a key), leaving what nears a held item", () => {
    expect(text(tieSuggestSql(ctx, p2))).toContain("row_number() over (partition by a_id order by b_bd, b_et, b_rid) as fa, row_number() over (partition by b_id order by a_bd, a_et, a_rid) as fb");
    expect(text(tieSuggestSql(ctx, p2))).toContain("where fa = 1 and fb = 1 and a_lk and b_lk");
    const b = text(tieBreakSql(ctx, p2));
    expect(b).toContain("held as (select a_id as id from c where not a_lk union select b_id from c where not b_lk)");
    expect(b).toContain("from c where a_id not in (select id from near)");
    expect(b).toContain("set status = 'break', break_reason = $");
    expect(breakReason(p2)).toBe("Duplicate");
    expect(breakReason(pass({ predicates: [{ op: "date_window", field: "business_date", days: 1 }] }))).toBe("Ambiguous");
  });

  it("a group pass sums the many side per one-side item, which must hold its many-side items alone", () => {
    const s = text(groupAcceptSql(ctx, pass({ cardinality: "N:1", blocking: ["attrs.sid"], predicates: [{ op: "eq_sum", field: "amount_minor", tolerance: {} }] })));
    expect(s).toContain("cg as (select b_id as o_id");
    expect(s).toContain("count(*) over (partition by m_id) as m_n");
    expect(s).toContain("bool_and(m_n = 1) as uniq");
    expect(s).toContain("bool_and(m_lk) and o_lk as all_lk");
    expect(s).toContain("where uniq and all_lk and abs(s - o_s) <= coalesce(($");
    expect(s).toContain("select gid, $74::uuid, o_id, $75::text, o_own from acc union all select gid, $76::uuid, m_id, $77::text, m_own from ms");
  });

  it("amounts: a negating side compares the negated signed amount; members keep the record's own (own)", () => {
    const p = pass({ predicates: [{ op: "eq", field: "amount_minor" }] });
    const neg = text(poolSql({ ...ctx, sides: [side("a"), side("b", true)] }, p, 1));
    expect(neg).toContain('end) as own, (-(case when upper(btrim("records"."direction"))');
    expect(text(poolSql(ctx, p, 1))).not.toContain("(-(case");
  });

  it("empty text never matches: eq_normalized and contains columns are nullif(…, '')", () => {
    const p = pass({ predicates: [{ op: "eq_normalized", field: "ext_ref" }, { op: "contains", field: "attrs.sid" }] });
    const s = text(poolSql(ctx, p, 0));
    expect(s).toContain(`nullif(regexp_replace(upper(btrim("records"."ext_ref")), '[^A-Z0-9]', '', 'g'), '') as x0`);
    expect(s).toContain(`nullif(("records"."attrs" ->> $`);
  });

  it("replaced records: open items of the window whose record no longer counts close, locked skipping held ones", () => {
    const s = text(closeReplacedSql(ctx, 0));
    expect(s).toContain("and not exists (select 1 from \"records\" where");
    expect(s).toContain("for update of i skip locked)");
    expect(s).toContain("set status = 'closed', break_reason = $");
  });

  it("intake: one date's records past a seq, in seq order, current and filtered, without an item yet", () => {
    const s = text(intakeSql(ctx, 1, [{ field: "direction", op: "eq", value: "credit" }], "2026-11-02", 7, 500));
    expect(s).toContain('where "records"."space_id" = $');
    expect(s).toContain('"records"."business_date" = $');
    expect(s).toContain('and "records"."seq" > $');
    expect(s).toContain('order by "records"."seq" limit $');
    expect(s).toContain('"records"."direction" = $');
    expect(s).toContain("not exists (select 1 from \"recon_items\" x where");
    expect(s).toContain("on conflict do nothing returning 1");
  });
});
