import { describe, expect, it } from "vitest";
import { buildCatalog, conditionText, evaluate } from "./conditions";
import { ReconApprovalSpec } from "./contracts/recon";
import type { RecordField } from "./recon";

const f = (kind: RecordField["kind"]): RecordField => ({ kind, from: null, fromType: null });
const catalog = buildCatalog([
  { label: "BI", fields: new Map([["reference", f("text")], ["attrs.channel", f("text")]]) },
  { label: "Core", fields: new Map([["attrs.e2e_id", f("text")]]) },
]);

describe("evaluate", () => {
  it("compares money as whole minor units", () => {
    const c = { all: [{ field: "break.amount", op: "gte" as const, value: "2500000000" }] };
    expect(evaluate(c, { "break.amount": "2500000000" })).toBe(true);
    expect(evaluate(c, { "break.amount": "1" })).toBe(false);
    expect(evaluate({ all: [{ field: "break.amount", op: "gte", value: "999999999999999998" }] }, { "break.amount": "999999999999999999" })).toBe(true);
  });
  it("a field the data doesn't have fails its clause, never throws", () => {
    expect(evaluate({ all: [{ field: "side_a.attrs.channel", op: "in", value: ["RTGS"] }] }, {})).toBe(false);
  });
  it("any of a nested all, or a single clause", () => {
    const c = { any: [{ all: [{ field: "t", op: "eq" as const, value: "A" }, { field: "s", op: "eq" as const, value: "C" }] }, { field: "t", op: "eq" as const, value: "1" }] };
    expect(evaluate(c, { t: "A", s: "C" })).toBe(true);
    expect(evaluate(c, { t: "1" })).toBe(true);
    expect(evaluate(c, { t: "A", s: "B" })).toBe(false);
  });
  it("text is trimmed; starts with and contains ignore case", () => {
    expect(evaluate({ all: [{ field: "x", op: "starts_with", value: "RTGS" }] }, { x: "  rtgs-01 " })).toBe(true);
    expect(evaluate({ all: [{ field: "x", op: "contains", value: "TG" }] }, { x: "rtgs" })).toBe(true);
    expect(evaluate({ all: [{ field: "x", op: "empty" }] }, { x: "  " })).toBe(true);
    expect(evaluate({ all: [{ field: "x", op: "not_in", value: ["A"] }] }, { x: "B" })).toBe(true);
  });
});

describe("catalog and sentences", () => {
  it("names side fields after their side and a readable attr", () => {
    expect(catalog.find((c) => c.key === "side_b.attrs.e2e_id")).toMatchObject({ label: "Core · E2e id", group: "side_b", kind: "text" });
    expect(catalog.find((c) => c.key === "break.amount")).toMatchObject({ label: "Amount", kind: "money" });
  });
  it("reads a rule as a sentence", () => {
    expect(conditionText({ all: [{ field: "break.amount", op: "gte", value: "2500000000" }, { field: "side_a.attrs.channel", op: "in", value: ["RTGS"] }] }, catalog))
      .toBe("Amount is at least 2500000000 and BI · Channel is one of RTGS");
  });
});

describe("ReconApprovalSpec", () => {
  const W = { id: "0190f5a0-0000-7000-8000-000000000001", version: 1 };
  const rule = { name: "R", when: { all: [{ field: "break.amount", op: "gte", value: "1" }] }, workflow: W };
  it("caps rules at 20 and nesting at 2 levels", () => {
    expect(ReconApprovalSpec.safeParse({ changes: { unmatch: { workflow: { default: W, rules: Array(21).fill(rule) } } } }).success).toBe(false);
    const deep = { all: [{ any: [{ all: [{ field: "x", op: "eq", value: "1" }] }] }] };
    expect(ReconApprovalSpec.safeParse({ changes: { unmatch: { workflow: { default: null, rules: [{ ...rule, when: deep }] } } } }).success).toBe(false);
    expect(ReconApprovalSpec.safeParse({ changes: { unmatch: { workflow: { default: W, rules: [rule] } } } }).success).toBe(true);
  });
});
