import { describe, expect, it } from "vitest";
import type { ReportSpec } from "@starterkit/shared/contracts/reports";
import { REPORT_STEPS, stepProblem, toggleStatus, withFormat, withKind } from "./spec-model";

const spec = (o: Partial<ReportSpec> = {}): ReportSpec => ({
  kind: "transactions", rows: { statuses: [], side: "both", reasons: [] }, columns: [], groups: [], totals: [],
  output: { format: "csv", fileName: "{recon}_{from}_{to}", masking: "masked" }, when: { afterRun: false, onRequest: true }, official: false, ...o,
} as ReportSpec);

describe("the draft's steps", () => {
  it("are the recon setup's pattern, five of them", () => {
    expect(REPORT_STEPS.map((s) => s.label)).toEqual(["Content", "Columns and groups", "Output", "Test", "Review and submit"]);
  });
  it("say what each step still needs", () => {
    expect(stepProblem(spec(), 2)).toBe("Pick at least one column.");
    expect(stepProblem(spec({ kind: "daily_summary" }), 2)).toBeNull();
    expect(stepProblem(spec({ kind: "grouped", columns: [{ key: "a:ext_ref", header: "Ref" }] }), 2)).toBe("Pick a column to group the rows by.");
    expect(stepProblem(spec({ output: { format: "csv", fileName: "", masking: "masked" } }), 3)).toBe("Name the file.");
    expect(stepProblem(spec({ output: { format: "csv", fileName: "x", masking: "full" } }), 5)).toBe("Full customer data needs an official report: turn on Official report, or mask it.");
    expect(stepProblem(spec({ when: { afterRun: false, onRequest: false } }), 5)).toBe("Make it after every run, on request, or both.");
  });
  it("a kind change drops groups a non-grouped report can't keep; a PDF of transactions warns of its limit", () => {
    expect(withKind(spec({ kind: "grouped", groups: ["recon:reason"] }), "transactions").groups).toEqual([]);
    expect(withFormat(spec(), "pdf").output.format).toBe("pdf");
    expect(toggleStatus(spec(), "unmatch").rows.statuses).toEqual(["unmatch"]);
    expect(toggleStatus(toggleStatus(spec(), "unmatch"), "unmatch").rows.statuses).toEqual([]);
  });
});
