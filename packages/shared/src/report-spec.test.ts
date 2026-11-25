import { describe, expect, it } from "vitest";
import { ReportSpec } from "./contracts/reports";
import { emptySpec, fromV1, parseStoredSpec } from "./report-spec";

const v1Base = { rows: { statuses: [], side: "both", reasons: [] }, columns: [], groups: [], totals: [], when: { afterRun: false, onRequest: true }, official: false };

describe("fromV1", () => {
  it("transactions: same columns in order, statuses and side as filters, output kept", () => {
    const v2 = fromV1({ ...v1Base, kind: "transactions", rows: { statuses: ["unmatch"], side: "a", reasons: ["Amount differs"] },
      columns: [{ key: "recon:businessDate", header: "Business date" }, { key: "a:amount_minor", header: "Amount" }],
      output: { format: "xlsx", fileName: "{recon}_{from}", masking: "masked", title: "Breaks" } } as never);
    expect(v2.dataset).toBe("results");
    expect(v2.columns.map((c) => [c.header, c.content])).toEqual([["Business date", { kind: "field", ref: "recon:businessDate" }], ["Amount", { kind: "field", ref: "a:amount_minor" }]]);
    expect(v2.columns[1]!.format.kind).toBe("number");
    expect(v2.rows.filters).toEqual([
      { ref: "recon:status", op: "any_of", value: ["unmatch"] }, { ref: "recon:side", op: "any_of", value: ["a"] }, { ref: "recon:reason", op: "any_of", value: ["Amount differs"] },
    ]);
    expect(v2.output).toMatchObject({ format: "xlsx", fileName: "{recon}_{from}", masking: "masked" });
    expect(v2.sections.title).toEqual({ on: true, text: "Breaks" });
    expect(ReportSpec.safeParse(v2).success).toBe(true);
  });
  it("grouped: groups and per-group totals; daily summary: the recap dataset", () => {
    const g = fromV1({ ...v1Base, kind: "grouped", columns: [{ key: "recon:reason", header: "Reason" }, { key: "a:amount_minor", header: "Amount" }], groups: ["recon:reason"],
      totals: [{ fn: "count" }, { fn: "sum", column: "a:amount_minor" }], output: { format: "csv", fileName: "x", masking: "masked" } } as never);
    expect(g.groups).toEqual(["recon:reason"]);
    expect(g.totals).toEqual({ on: true, perGroup: true, columns: { [g.columns[1]!.id]: "sum" } });
    const d = fromV1({ ...v1Base, kind: "daily_summary", output: { format: "pdf", fileName: "x", masking: "masked" } } as never);
    expect(d.dataset).toBe("recap");
    expect(d.columns.map((c) => (c.content as { ref: string }).ref)).toEqual(["recap:date", "recap:results", "recap:matched", "recap:breaks", "recap:match_rate"]);
    expect(ReportSpec.safeParse(d).success).toBe(true);
  });
});

describe("parseStoredSpec and the contract", () => {
  it("a v2 spec reads as itself; a v1 one is converted", () => {
    const e = emptySpec();
    expect(parseStoredSpec(e)).toEqual(e);
    expect(parseStoredSpec({ ...v1Base, kind: "transactions", output: { format: "csv", fileName: "x", masking: "masked" } }).v).toBe(2);
  });
  it("an empty spec: results, no column, every section on, CSV, masked, on request", () => {
    const e = emptySpec();
    expect(e).toMatchObject({ v: 2, dataset: "results", columns: [], output: { format: "csv", masking: "masked" }, official: false, when: { afterRun: false, onRequest: true } });
    expect([e.sections.title.on, e.sections.header.on, e.sections.columnHeaders, e.sections.footer.on, e.totals.on]).toEqual([true, true, true, true, true]);
  });
  it("refuses full data without official, two columns with one id, and an unknown filter op", () => {
    const e = emptySpec();
    expect(ReportSpec.safeParse({ ...e, output: { ...e.output, masking: "full" } }).error?.issues[0]?.message).toBe("Only an official report shows customer data in full.");
    const col = { id: "c1", header: "A", content: { kind: "rownum" }, format: { kind: "auto" }, layout: { align: "l", width: 10, pad: " " } };
    expect(ReportSpec.safeParse({ ...e, columns: [col, col] }).error?.issues[0]?.message).toBe("Two columns have one id.");
    expect(ReportSpec.safeParse({ ...e, rows: { filters: [{ ref: "recon:status", op: "near", value: [] }] } }).success).toBe(false);
  });
});
