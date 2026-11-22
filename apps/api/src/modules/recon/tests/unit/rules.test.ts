// The recon contract (ReconSpec, tolerance per currency) and checkReconSpec: the field whitelist per side, operator
// kinds, pass numbers, eq_sum, currencies across sides, and the carry-over guardrail (plan "Config gerbang", A2, A3).
import { describe, expect, it } from "bun:test";
import { ReconSpec, UpdateReconVersionBody } from "@starterkit/shared/contracts/recon";
import { SourceSpec } from "@starterkit/shared/contracts/sources";
import { recordFields } from "@starterkit/shared/recon";
import { checkActions, checkApprovals, checkReconSpec, reconIssue, usedFields } from "../../rules";
import { buildCatalog } from "@starterkit/shared/conditions";
import { gate, sourceSpec } from "../spec";

const A = Bun.randomUUIDv7(), B = Bun.randomUUIDv7();
const parse = (v: unknown) => ReconSpec.parse(v);
const src = (n: 1 | 2 = 1, currencies: string[] = ["IDR", "USD"]) => ({ spec: SourceSpec.parse(sourceSpec(n)), currencies });
const sides = () => [src(1), src(2)] as const;
const check = (spec: unknown, s: Parameters<typeof checkReconSpec>[1] = sides()) => checkReconSpec(parse(spec), s);
const issueOf = (body: unknown) => reconIssue(UpdateReconVersionBody.safeParse(body).error);

describe("ReconSpec", () => {
  it("takes the gate config; exactly two sides, a then b", () => {
    expect(ReconSpec.safeParse(gate(A, B)).success).toBe(true);
    const g = gate(A, B);
    expect(ReconSpec.safeParse({ ...g, sides: [g.sides[0]] }).success).toBe(false);
    expect(ReconSpec.safeParse({ ...g, sides: [...g.sides, { ...g.sides[1], key: "b" }] }).success).toBe(false);
    expect(issueOf({ spec: { ...g, sides: [g.sides[1], g.sides[0]] } })).toBe("Side A: List side A first, then side B.");
  });

  it("a field is a core column or attrs.<name>; operators are the closed list", () => {
    const g = gate(A, B);
    const withPredicate = (p: unknown) => ({ ...g, passes: [{ ...g.passes[0], predicates: [p] }] });
    expect(ReconSpec.safeParse(withPredicate({ op: "eq", field: "attrs.settlement_ref" })).success).toBe(true);
    expect(ReconSpec.safeParse(withPredicate({ op: "eq", field: "amount" })).success).toBe(false);
    expect(ReconSpec.safeParse(withPredicate({ op: "eq", field: "attrs.Bad-Name" })).success).toBe(false);
    expect(ReconSpec.safeParse(withPredicate({ op: "regex", field: "ext_ref" })).success).toBe(false);
  });

  it("a tolerance is per currency in major units, no more decimals than the currency has (ISO 4217)", () => {
    const g = gate(A, B);
    const tol = (tolerance: unknown) => ({ spec: { ...g, passes: [g.passes[0], { ...g.passes[1], predicates: [{ op: "amount_abs_tol", field: "amount_minor", tolerance }] }] } });
    expect(issueOf(tol({ IDR: "1000.00", USD: "0.5", JPY: "100", KWD: "0.125" }))).toBeNull();
    expect(UpdateReconVersionBody.safeParse(tol({ IDR: "1000.00" })).success).toBe(true);
    expect(issueOf(tol({ JPY: "1.5" }))).toBe("Pass 2, condition 1, JPY tolerance: 1 decimal place; JPY allows 0.");
    expect(issueOf(tol({ IDR: "0.001" }))).toBe("Pass 2, condition 1, IDR tolerance: 3 decimal places; IDR allows 2.");
    expect(issueOf(tol({ XYZ: "1" }))).toBe("Pass 2, condition 1, XYZ tolerance: Use an ISO currency code the product knows, such as IDR.");
    expect(issueOf(tol({ idr: "1" }))).toBe("Pass 2, condition 1, idr tolerance: Use an ISO currency code the product knows, such as IDR.");
    expect(UpdateReconVersionBody.safeParse(tol({ IDR: "-1" })).success).toBe(false);
    expect(UpdateReconVersionBody.safeParse(tol({ IDR: 1000 })).success).toBe(false); // decimal text, never a float
  });
});

describe("recordFields (the FieldRef whitelist)", () => {
  it("the core columns a source version maps and its attrs, each with its kind", () => {
    const f = recordFields(SourceSpec.parse(sourceSpec(1)));
    expect([...f.keys()].sort()).toEqual(["account_ref", "amount_minor", "attrs.settlement_ref", "business_date", "currency", "ext_ref"]);
    expect(f.get("amount_minor")).toEqual({ kind: "decimal", from: "amount", fromType: "decimal" });
    expect(f.get("attrs.settlement_ref")).toEqual({ kind: "text", from: "settlement_ref", fromType: "string" });
    // a fixed currency of every row is a currency on every record
    const fixed = SourceSpec.parse({ ...sourceSpec(1), mapping: { ...sourceSpec(1).mapping, currency: undefined }, currency: "IDR" });
    expect(recordFields(fixed).get("currency")).toEqual({ kind: "text", from: null, fromType: null });
  });
});

describe("checkReconSpec", () => {
  it("the gate config has no error and no gate; USD has no tolerance in pass 2 (a warning)", () => {
    expect(check(gate(A, B))).toEqual({ errors: [], gates: [], warnings: ["USD has no tolerance in pass 2; USD pairs must match exactly."] });
    // with no record of USD seen, nothing to warn about
    expect(check(gate(A, B), [src(1, ["IDR"]), src(2, ["IDR"])]).warnings).toEqual([]);
  });

  it("carry over shorter than a pass's date window blocks submit on a daily schedule only", () => {
    const g = { ...gate(A, B), carry_over_days: 0 };
    expect(check(g).gates).toEqual(["Pass 3 allows dates 1 day apart, but carry over is 0 days: pairs across days never meet in a daily run. Set carry over to 1 day."]);
    expect(check({ ...g, schedule: { kind: "interval", every_minutes: 15 } }).gates).toEqual([]);
    const wide = gate(A, B);
    wide.passes[2]!.predicates[1] = { op: "bday_window", field: "business_date", days: 3 } as never;
    expect(check(wide).gates).toEqual(["Pass 3 allows dates 3 days apart, but carry over is 1 day: pairs across days never meet in a daily run. Set carry over to 3 days."]);
  });

  it("a field the side's source doesn't have, or of a kind the operator can't take, is an error with its path", () => {
    const g = gate(A, B);
    g.passes[1]!.predicates[0] = { op: "amount_abs_tol", field: "ext_ref", tolerance: { IDR: "1000.00" } };
    expect(check(g).errors).toEqual([
      "Pass 2, condition 1, Source 1: Amount is decimal; this side's field is text.",
      "Pass 2, condition 1, Source 2: Amount is decimal; this side's field is text.",
    ]);
    const h = gate(A, B);
    h.passes[0]!.predicates.push({ op: "eq", field: "attrs.rrn" });
    h.sides[1].filter = [{ field: "direction", op: "eq", value: "C" }] as never;
    expect(check(h).errors).toEqual([
      "Side B, filter 1: Source 2 has no field direction.",
      "Pass 1, condition 5: Source 1 has no field rrn.",
      "Pass 1, condition 5: Source 2 has no field rrn.",
    ]);
    const v = gate(A, B);
    v.sides[0].filter = [{ field: "amount_minor", op: "in", values: ["100", "ten"] }, { field: "business_date", op: "ne", value: "2026-11-02" }] as never;
    expect(check(v).errors).toEqual(['Side A, filter 1: "ten" is not a number.']);
    const d = gate(A, B);
    d.passes[2]!.predicates[1] = { op: "date_window", field: "ext_ref", days: 1 };
    expect(check(d).errors[0]).toBe("Pass 3, condition 2, Source 1: A date window compares dates; this side's field is text.");
    const bd = gate(A, B);
    bd.passes[2]!.predicates[1] = { op: "bday_window", field: "event_time", days: 1 } as never;
    expect(check(bd).errors).toContain("Pass 3, condition 2: Business days are counted on the business date. Compare the business date.");
  });

  it("a side whose source has no published version is an error", () => {
    expect(check(gate(A, B), [src(1), { spec: null, currencies: [] }]).errors).toEqual(["Side B: Source 2 has no published version yet."]);
    expect(check(gate(A, B), [src(1), { spec: null, currencies: [], name: "Core BI-FAST" }]).errors).toEqual(["Side B: Core BI-FAST has no published version yet."]);
  });

  it("passes are numbered 1, 2, 3 … in order", () => {
    const g = gate(A, B);
    g.passes[2]!.no = 4;
    expect(check(g).errors).toEqual(["Number the passes 1, 2, 3 … in order, with no gaps."]);
  });

  it("eq_sum only in a 1:N or N:1 pass, which needs one eq_sum and a blocking key (A3)", () => {
    const g = gate(A, B);
    g.passes[0]!.predicates.push({ op: "eq_sum", field: "amount_minor" } as never);
    expect(check(g).errors).toEqual(["Pass 1, condition 5: A group sum needs a 1:N or N:1 pass."]);
    const settle = (over: object) => {
      const s = gate(A, B);
      s.passes.push({ no: 4, name: "Settlement", cardinality: "N:1", blocking: ["attrs.settlement_ref"], accept: "auto", on_ambiguous: "break",
        predicates: [{ op: "eq_sum", field: "amount_minor", tolerance: {} }, { op: "eq", field: "currency" }], ...over } as never);
      return check(s);
    };
    expect(settle({}).errors).toEqual([]);
    expect(settle({ blocking: [] }).errors).toEqual(["Pass 4: A 1:N or N:1 pass groups records by a matching key. Add one, such as a settlement reference."]);
    expect(settle({ predicates: [{ op: "eq", field: "currency" }] }).errors).toEqual(["Pass 4: A 1:N or N:1 pass needs one group sum condition."]);
    // phase 1: a group pass matches automatically or raises breaks, never suggests (Plan 3 Task 2 review, I4)
    const only = ["Pass 4 groups several items; it can only match automatically or raise breaks in this release."];
    expect(settle({ accept: "suggest" }).errors).toEqual(only);
    expect(settle({ on_ambiguous: "suggest" }).errors).toEqual(only);
    // a group across days is held to carry over as a pair is
    const wide = settle({ predicates: [{ op: "eq_sum", field: "amount_minor" }, { op: "eq", field: "currency" }, { op: "date_window", field: "business_date", days: 2 }] });
    expect(wide.gates).toEqual(["Pass 4 allows dates 2 days apart, but carry over is 1 day: groups across days never meet in a daily run. Set carry over to 2 days."]);
    // each side names its own field: side A's settlement reference against side B's reference
    expect(settle({ blocking: [{ a: "attrs.settlement_ref", b: "ext_ref" }] }).errors).toEqual([]);
    expect(settle({ blocking: [{ a: "attrs.settlement_ref", b: "attrs.batch" }] }).errors).toEqual(["Pass 4, matching key 1: Source 2 has no field batch."]);
    const mixed = settle({ predicates: [{ op: "eq_sum", field: { a: "amount_minor", b: "ext_ref" } }, { op: "eq", field: "currency" }] });
    expect(mixed.errors).toEqual(["Pass 4, condition 1, Source 2: Amount is decimal; this side's field is text."]);
    const kinds = gate(A, B);
    kinds.passes[0]!.predicates[0] = { op: "eq", field: { a: "ext_ref", b: "business_date" } } as never;
    expect(check(kinds).errors).toEqual(["Pass 1, condition 1: Source 1's reference is text; Source 2's business date is date."]);
    const keys = gate(A, B);
    keys.passes[1]!.blocking = [{ a: "ext_ref", b: "business_date" }];
    expect(check(keys).errors).toEqual(["Pass 2, matching key 1: Source 1's reference is text; Source 2's business date is date."]);
  });

  it("an amount compared across sides that hold more than one currency needs currency eq; the pass is named (A2)", () => {
    const g = gate(A, B);
    g.passes[1]!.predicates.pop();
    expect(check(g).errors).toEqual(["Pass 2 compares amounts but has no currency condition. Add one so amounts in different currencies never match."]);
    // currency in the blocking keys is the same check
    g.passes[1]!.blocking.push("currency");
    expect(check(g).errors).toEqual([]);
    // an amount as a matching key compares amounts too
    const k = gate(A, B);
    k.passes[0]!.predicates = [{ op: "eq", field: "ext_ref" }];
    k.passes[0]!.blocking = ["amount_minor"];
    expect(check(k).errors).toEqual(["Pass 1 compares amounts but has no currency condition. Add one so amounts in different currencies never match."]);
    // two sides with one fixed currency each, the same: no currency eq needed
    const fixed = SourceSpec.parse({ ...sourceSpec(1), mapping: { ...sourceSpec(1).mapping, currency: undefined }, currency: "IDR" });
    const h = gate(A, B);
    h.passes[1]!.predicates.pop();
    expect(check(h, [{ spec: fixed, currencies: [] }, { spec: fixed, currencies: [] }]).errors).toEqual([]);
    const usd = SourceSpec.parse({ ...sourceSpec(2), mapping: { ...sourceSpec(2).mapping, currency: undefined }, currency: "USD" });
    expect(check(h, [{ spec: fixed, currencies: [] }, { spec: usd, currencies: [] }]).errors).toEqual(["Pass 2 compares amounts but has no currency condition. Add one so amounts in different currencies never match."]);
  });

  it("usedFields: every field a side's filters and the passes name, per side, and direction where the side maps it", () => {
    const g = gate(A, B);
    g.sides[0].filter = [{ field: "account_ref", op: "not_null" }] as never;
    g.passes[2]!.blocking = [{ a: "attrs.settlement_ref", b: "ext_ref" }] as never;
    expect(usedFields(parse(g), [false, true])).toEqual([
      ["account_ref", "amount_minor", "attrs.settlement_ref", "business_date", "currency", "ext_ref"],
      ["amount_minor", "business_date", "currency", "direction", "ext_ref"],
    ]);
  });

  it("usedFields: the fields an approval rule reads count for their side, so a source version can't drop them unseen", () => {
    const g = { ...gate(A, B), approvals: { changes: { unmatch: { workflow: { default: null, rules: [{ name: "RTGS", workflow: { id: "0190f5a0-0000-7000-8000-00000000000a", version: 1 },
      when: { all: [{ field: "side_a.attrs.channel", op: "in", value: ["RTGS"] }, { field: "side_b.account_ref", op: "not_empty" }, { field: "break.amount", op: "gte", value: "1" }] } }] } } } } };
    const [a, b] = usedFields(parse(g));
    expect([a.includes("attrs.channel"), b.includes("account_ref"), a.includes("break.amount")]).toEqual([true, true, false]);
  });

  it("a side reads its amount as it is or negated (amount_sign); negating needs an amount, which it then uses", () => {
    expect(parse(gate(A, B)).sides.map((x) => x.amount_sign)).toEqual(["as_is", "as_is"]);
    const g = gate(A, B);
    g.sides[1] = { ...g.sides[1], amount_sign: "negate" } as never;
    expect(check(g).errors).toEqual([]);
    expect(usedFields(parse(g))[1]).toContain("amount_minor");
    const noAmount = SourceSpec.parse({ ...sourceSpec(2), mapping: { ...sourceSpec(2).mapping, amount_minor: undefined } });
    const n = check(g, [src(1), { spec: noAmount, currencies: [] }]);
    expect(n.errors).toContain("Side B: Source 2 has no amount to negate. Map an amount in its source or read the sign as it is.");
    expect(() => parse({ ...gate(A, B), passes: [{ ...gate(A, B).passes[0], min_score: 0.5 }] })).toThrow();
  });

  it("a filter on direction names debit or credit, as records store it", () => {
    const withDirection = SourceSpec.parse({ ...sourceSpec(1), mapping: { ...sourceSpec(1).mapping, direction: { field: "settlement_ref" } } });
    const g = gate(A, B);
    g.sides[0].filter = [{ field: "direction", op: "in", values: ["debit", "D"] }] as never;
    expect(check(g, [{ spec: withDirection, currencies: [] }, src(2)]).errors).toEqual(['Side A, filter 1: "D" is not a direction. Use debit or credit.']);
    g.sides[0].filter = [{ field: "direction", op: "eq", value: "credit" }] as never;
    expect(check(g, [{ spec: withDirection, currencies: [] }, src(2)]).errors).toEqual([]);
  });

  it("every sentence names fields and steps as the builder does: no spec path, code field or operator name", () => {
    const bad = gate(A, B);
    bad.carry_over_days = 0;
    bad.sides[1].filter = [{ field: "attrs.rrn", op: "eq", value: "x" }];
    bad.passes[0]!.predicates.push({ op: "eq_sum", field: "attrs.settlement_ref" } as never, { op: "contains", field: "amount_minor" } as never);
    bad.passes[1]!.predicates = [{ op: "amount_abs_tol", field: "ext_ref", tolerance: { IDR: "1.00" } }];
    bad.passes[2]!.no = 7;
    const r = check(bad, [src(1), { spec: null, currencies: [] }]);
    const said = [...r.errors, ...r.gates, ...r.warnings, issueOf({ spec: { ...gate(A, B), sides: [gate(A, B).sides[1], gate(A, B).sides[0]] } })!];
    expect(said.length).toBeGreaterThan(5);
    for (const s of said) expect([s, /attrs\.|_ref\b|amount_minor|business_date|eq_sum|amount_abs_tol|predicates|passes\.|sides\.|DEC-|REC-/.test(s)]).toEqual([s, false]);
  });
});

describe("checkApprovals (DEC-052 rev 2)", () => {
  const W = "0190f5a0-0000-7000-8000-00000000000a", S = "0190f5a0-0000-7000-8000-0000000000aa";
  const cat = buildCatalog([{ label: "BI", fields: new Map([["attrs.channel", { kind: "text" as const, from: null, fromType: null }]]) }, { label: "Core", fields: new Map() }]);
  const facts = (o: Partial<{ spaceId: string; archived: boolean; versions: number[] }> = {}) =>
    new Map([[W, { spaceId: o.spaceId ?? S, name: "Treasury head", archived: o.archived ?? false, versions: new Set(o.versions ?? [1]) }]]);
  const setup = (when: object = { all: [{ field: "side_a.attrs.channel", op: "in", value: ["RTGS"] }] }, version = 1) =>
    ({ changes: { unmatch: { workflow: { default: { id: W, version }, rules: [{ name: "Large", when, workflow: { id: W, version } }] } } } }) as never;
  it("passes a setup that names a published version and catalog fields", () => {
    expect(checkApprovals(setup(), cat, facts(), S)).toEqual([]);
  });
  it("names the change and the problem for each wrong reference", () => {
    expect(checkApprovals(setup(), cat, new Map(), S)).toContain("Unmatch: a picked workflow no longer exists. Pick another one.");
    expect(checkApprovals(setup(), cat, facts({ archived: true }), S)).toContain("Unmatch: workflow “Treasury head” is archived. Pick another one.");
    expect(checkApprovals(setup(undefined, 2), cat, facts(), S)).toContain("Unmatch: version 2 of “Treasury head” was never published. Pick a published version.");
    expect(checkApprovals(setup(), cat, facts({ spaceId: Bun.randomUUIDv7() }), S)).toContain("Unmatch: a picked workflow no longer exists. Pick another one.");
    expect(checkApprovals(setup({ all: [{ field: "side_a.attrs.branch", op: "eq", value: "01" }] }), cat, facts(), S))
      .toContain("Unmatch · rule “Large”: a field it checks is no longer read from the sources (side_a.attrs.branch).");
    expect(checkApprovals(setup({ all: [{ field: "break.amount", op: "starts_with", value: "1" }] }), cat, facts(), S))
      .toContain("Unmatch · rule “Large”: Amount can't be compared with “starts with”.");
  });
});

describe("checkActions (stage 4)", () => {
  const C = "0190f5a0-0000-7000-8000-0000000000c1";
  const cat = buildCatalog([{ label: "BI", fields: new Map([["attrs.e2e_id", { kind: "text" as const, from: null, fromType: null }]]) }, { label: "Core", fields: new Map() }]);
  const facts = new Map([[C, { name: "Bank Mega", disabled: false, versions: new Map([[2, { operations: new Map([["misc_dc", {
    name: "Misc D/C", request: [{ name: "Amount", type: "numeric" as const, required: true }, { name: "DE48", type: "object" as const, required: true, children: [{ name: "Remark", type: "string" as const, required: true }, { name: "Cur", type: "string" as const, required: true }] }],
    presets: new Set(["DE48.Cur"]), auto: new Set<string>(),
  }]]) }]]) }]]);
  const variant = (o: object = {}) => ({ name: "Default", when: { all: [] }, operation: { connectorId: C, version: 2, key: "misc_dc" }, per: "item", zeroOrNegative: "skip",
    mapping: { Amount: { kind: "field", key: "break.amount", transforms: [] }, "DE48.Remark": { kind: "template", text: "{side_a.attrs.e2e_id}" } }, ...o });
  const setup = (v: object) => ({ accounts: [], lookups: [], changes: { unmatch: { workflow: { default: null, rules: [] }, actions: [{ name: "Post to GL", kind: "posting", on: { event: "approved" }, variants: [v] }] } } }) as never;
  it("passes a variant that maps every required field (fixed values count)", () => {
    expect(checkActions(setup(variant()), cat, facts)).toEqual([]);
  });
  it("names change, action and variant for each problem", () => {
    const where = "Unmatch · Post to GL · Default";
    expect(checkActions(setup(variant({ operation: { connectorId: Bun.randomUUIDv7(), version: 2, key: "misc_dc" } })), cat, facts)).toEqual([`${where}: the connector picked no longer exists. Pick another one.`]);
    expect(checkActions(setup(variant({ operation: { connectorId: C, version: 9, key: "misc_dc" } })), cat, facts)).toEqual([`${where}: version 9 of “Bank Mega” was never published. Pick a published version.`]);
    expect(checkActions(setup(variant({ operation: { connectorId: C, version: 2, key: "nope" } })), cat, facts)).toEqual([`${where}: “Bank Mega” version 2 has no operation nope.`]);
    expect(checkActions(setup(variant({ mapping: { Amount: { kind: "const", value: "1" } } })), cat, facts)).toEqual([`${where}: DE48.Remark is required. Map it, or give it a fixed or auto value.`]);
    expect(checkActions(setup(variant({ mapping: { Amount: { kind: "const", value: "1" }, "DE48.Remark": { kind: "const", value: "x" }, Extra: { kind: "const", value: "x" } } })), cat, facts)).toEqual([`${where}: Extra isn't a request field of Misc D/C.`]);
    expect(checkActions(setup(variant({ mapping: { Amount: { kind: "field", key: "side_a.attrs.gone", transforms: [] }, "DE48.Remark": { kind: "template", text: "{side_b.attrs.lost}" } } })), cat, facts))
      .toEqual([`${where}: a field it reads is no longer read from the sources (side_a.attrs.gone, side_b.attrs.lost).`]);
  });
  it("approval fields may be read by a variant", () => {
    expect(checkActions(setup(variant({ when: { all: [{ field: "approval.level", op: "eq", value: "1" }] } })), cat, facts)).toEqual([]);
  });
});
