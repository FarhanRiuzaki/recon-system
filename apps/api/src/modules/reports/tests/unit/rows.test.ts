import { describe, expect, it } from "bun:test";
import { emptySpec } from "@starterkit/shared/report-spec";
import type { ReportSpec } from "@starterkit/shared/contracts/reports";
import { major, passes, refsOfSpec } from "../../rows";

const withFilters = (filters: ReportSpec["rows"]["filters"]): ReportSpec => ({ ...emptySpec(), rows: { filters } });
const row = (values: Record<string, string | number | null>) => ({ date: "2026-11-25", values });

describe("passes", () => {
  it("each op; a result on both sides passes a side filter for either", () => {
    expect(passes(withFilters([{ ref: "recon:reason", op: "is", value: ["Amount differs"] }]), row({ "recon:reason": "Amount differs" }))).toBe(true);
    expect(passes(withFilters([{ ref: "recon:reason", op: "is_not", value: ["Amount differs"] }]), row({ "recon:reason": "Amount differs" }))).toBe(false);
    expect(passes(withFilters([{ ref: "a:ext_ref", op: "contains", value: ["ks"] }]), row({ "a:ext_ref": "KS-1" }))).toBe(true);
    expect(passes(withFilters([{ ref: "b:ext_ref", op: "empty", value: [] }]), row({ "b:ext_ref": null }))).toBe(true);
    expect(passes(withFilters([{ ref: "b:ext_ref", op: "not_empty", value: [] }]), row({ "b:ext_ref": null }))).toBe(false);
    expect(passes(withFilters([{ ref: "a:amount_minor", op: "gt", value: ["100"] }]), row({ "a:amount_minor": 150 }))).toBe(true);
    expect(passes(withFilters([{ ref: "a:amount_minor", op: "lt", value: ["100"] }]), row({ "a:amount_minor": 150 }))).toBe(false);
    expect(passes(withFilters([{ ref: "recon:side", op: "any_of", value: ["a"] }]), row({ "recon:side": "both" }))).toBe(true);
    expect(passes(withFilters([{ ref: "recon:side", op: "any_of", value: ["a"] }]), row({ "recon:side": "b" }))).toBe(false);
  });
});

describe("major and refsOfSpec", () => {
  it("minor units to major by the currency's exponent; other fields untouched", () => {
    expect(major("amount_minor", "15000", "IDR")).toBe(150);
    expect(major("amount_minor", "15000", "JPY")).toBe(15000);
    expect(major("ext_ref", "15000", "IDR")).toBe("15000");
    expect(major("amount_minor", null, "IDR")).toBeNull();
  });
  it("reads columns, fallbacks, formulas, filters, groups and header lines", () => {
    const s: ReportSpec = { ...emptySpec(),
      columns: [{ id: "c1", header: "A", content: { kind: "field", ref: "a:ext_ref", fallback: "b:ext_ref" }, format: { kind: "auto" }, layout: { align: "l", width: 10, pad: " " } },
        { id: "c2", header: "D", content: { kind: "formula", cel: "a.amount_minor - b.amount_minor" }, format: { kind: "auto" }, layout: { align: "l", width: 10, pad: " " } }],
      rows: { filters: [{ ref: "recon:status", op: "any_of", value: ["unmatch"] }] }, groups: ["a:attrs.member"],
      sections: { ...emptySpec().sections, header: { on: true, lines: [{ label: "Total", value: { kind: "sum", ref: "a:amount_minor" } }] } } };
    expect(refsOfSpec(s).sort()).toEqual(["a:amount_minor", "a:attrs.member", "a:ext_ref", "b:amount_minor", "b:ext_ref", "recon:status"]);
  });
});
