import { describe, expect, it } from "vitest";
import type { FieldSpec, SourceSpec } from "@starterkit/shared/contracts/sources";
import { suggestCore } from "./core-suggest";

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
    expect(suggestCore([f("amount", "decimal", { scale: 4 })], empty)).toEqual({});
  });
  it("two candidates for one field: none", () => {
    expect(suggestCore([f("amount", "integer"), f("amt", "integer"), f("ccy", "string")], empty)).toEqual({ currency: "ccy" });
  });
  it("never overwrites a set value, and does not reuse its column", () => {
    const m: SourceSpec["mapping"] = { business_date: { field: "tgl" }, currency: { field: "ref" }, amount_minor: { cel: "x" }, attrs: {} };
    expect(suggestCore([f("tgl", "date"), f("value_date", "date"), f("ref", "string"), f("amount", "integer"), f("txn_id", "string")], m)).toEqual({ ext_ref: "txn_id" });
  });
});
