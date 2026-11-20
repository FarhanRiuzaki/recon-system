import { describe, expect, it } from "vitest";
import type { FieldSpec, SourcePreviewDto, SourceSpec } from "@starterkit/shared/contracts/sources";
import { suggestCore, suggestUnit, unitExamples, withUnit as apply } from "./core-suggest";
import type { Draft } from "./model";

const f = (name: string, type: FieldSpec["type"], format?: FieldSpec["format"]): FieldSpec => ({ name, type, nullable: false, trim: type === "string", ...(format ? { format } : {}) });
const empty: SourceSpec["mapping"] = { business_date: { field: "" }, attrs: {} };

describe("core field suggestions", () => {
  it("the recon_source_test shapes", () => {
    const s1 = [f("id", "integer"), f("txn_ref", "string"), f("business_date", "date"), f("amount_minor", "integer"), f("ccy", "string"), f("account_no", "string"), f("updated_at", "datetime"), f("settled_at", "datetime")];
    const s2 = [f("id", "integer"), f("reference", "string"), f("value_date", "date"), f("amount", "decimal", { scale: 2 }), f("currency", "string"), f("acct", "string"), f("updated_at", "datetime"), f("note", "string")];
    expect(suggestCore(s1, empty)).toEqual({ ext_ref: "txn_ref", business_date: "business_date", amount_minor: "amount_minor", currency: "ccy", account_ref: "account_no" });
    expect(suggestCore(s2, empty)).toEqual({ ext_ref: "reference", business_date: "value_date", amount_minor: "amount", currency: "currency", account_ref: "acct" });
  });
  it("ignores case, underscores and spaces", () => {
    expect(suggestCore([f("Value Date", "date"), f("AMT", "integer")], empty)).toEqual({ business_date: "Value Date", amount_minor: "AMT" });
  });
  it("needs the type to fit", () => {
    expect(suggestCore([f("amount", "string"), f("date", "string"), f("ccy", "integer"), f("ref", "date")], empty)).toEqual({});
    expect(suggestCore([f("amount", "decimal", { scale: 4 })], empty)).toEqual({ amount_minor: "amount" }); // any scale (KWD has 3)
  });
  it("two candidates for one field: none", () => {
    expect(suggestCore([f("amount", "integer"), f("amt", "integer"), f("ccy", "string")], empty)).toEqual({ currency: "ccy" });
  });
  it("never overwrites a set value, and does not reuse its column", () => {
    const m: SourceSpec["mapping"] = { business_date: { field: "tgl" }, currency: { field: "ref" }, amount_minor: { cel: "x" }, attrs: {} };
    expect(suggestCore([f("tgl", "date"), f("value_date", "date"), f("ref", "string"), f("amount", "integer"), f("txn_id", "string")], m)).toEqual({ ext_ref: "txn_id" });
  });
});

type Rec = SourcePreviewDto["records"][number];
const rec = (currency: string | null, amountText: string | null): Rec => ({
  line: 1, businessDate: "2026-11-02", bdayIndex: 1, amountMinor: null, amountText, currency, direction: null, eventTime: null, extRef: null, accountRef: null, attrs: {}, naturalKey: null, rowHash: "h",
});

describe("amount unit", () => {
  it("is suggested from the column: decimal → currency units, integer named *_minor or *_cents → minor units, else none", () => {
    expect(suggestUnit(f("amount", "decimal", { scale: 2 }))).toEqual({ unit: "major", note: "Suggested: currency units. amount is a decimal number." });
    expect(suggestUnit(f("amount_minor", "integer"))).toEqual({ unit: "minor", note: "Suggested: minor units. amount_minor is a whole number and its name ends in _minor." });
    expect(suggestUnit(f("AMT_CENTS", "integer"))?.unit).toBe("minor");
    expect(suggestUnit(f("amount", "integer"))).toBeNull();
    expect(suggestUnit(f("amount_minor", "string"))).toBeNull();
    expect(suggestUnit(undefined)).toBeNull();
  });
  it("is applied while unset or still the suggestion, never over the user's choice", () => {
    const fields = [f("amount_minor", "integer"), f("amount", "decimal", { scale: 2 }), f("amt", "integer")];
    const at = (field: string, unit?: "major" | "minor") => ({ ...empty, amount_minor: { field, ...(unit ? { unit } : {}) } });
    const spec = (m: SourceSpec["mapping"]) => ({ fields, mapping: m }) as SourceSpec;
    const withUnit = (d: Pick<Draft, "spec" | "unitHint">) => apply(d);
    const a = withUnit({ spec: spec(at("amount_minor")) });
    expect([a.spec.mapping.amount_minor?.unit, a.unitHint?.unit]).toEqual(["minor", "minor"]);
    // the column changes while the unit is still the suggestion: the new column's suggestion
    const b = withUnit({ ...a, spec: spec(at("amount", "minor")) });
    expect([b.spec.mapping.amount_minor?.unit, b.unitHint?.unit]).toEqual(["major", "major"]);
    const c = withUnit({ ...a, spec: spec(at("amt", "minor")) });
    expect([c.spec.mapping.amount_minor?.unit, c.unitHint]).toEqual([undefined, undefined]); // no suggestion: the user chooses
    // the user chose (no hint): it stays whatever the column
    const d = withUnit({ spec: spec(at("amount", "minor")) });
    expect(d.spec.mapping.amount_minor?.unit).toBe("minor");
  });
  it("shows one example per currency of the sample, switching with the unit", () => {
    const rs = [rec("IDR", "2551779"), rec("IDR", "100"), rec("USD", "26230"), rec(null, "5"), rec("JPY", "1500")];
    expect(unitExamples(rs, "minor")).toEqual([
      "First IDR row: 2551779 is stored as IDR 25,517.79.", "First USD row: 26230 is stored as USD 262.30.", "First JPY row: 1500 is stored as JPY 1,500.",
    ]);
    expect(unitExamples(rs, "major")).toEqual([
      "First IDR row: 2551779 is stored as IDR 2,551,779.00.", "First USD row: 26230 is stored as USD 26,230.00.", "First JPY row: 1500 is stored as JPY 1,500.",
    ]);
    expect(unitExamples([rec("KWD", "1.234"), rec("JPY", "1500.5")], "major")).toEqual([
      "First KWD row: 1.234 is stored as KWD 1.234.", "First JPY row: 1500.5 can't be stored: 1 decimal place; JPY allows 0.",
    ]);
    expect(unitExamples([rec("IDR", "25517.79")], "minor")).toEqual(["First IDR row: 25517.79 can't be stored: 2 decimal places; minor units are whole numbers."]);
  });
});
