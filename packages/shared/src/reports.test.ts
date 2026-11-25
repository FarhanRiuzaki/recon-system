import { describe, expect, it } from "vitest";
import { ReportSpec } from "./contracts/reports";
import { fileNameOf, PDF_ROWS_MAX, REPORT_RANGE_MAX_DAYS, XLSX_ROWS_MAX } from "./reports";
import { mayDo } from "./spaces";

const t = { recon: "KSEI vs Core", template: "Daily recap", from: "2026-11-01", to: "2026-11-24" };
const spec = (o: Record<string, unknown> = {}) => ({
  kind: "transactions", rows: { statuses: ["break"], side: "both", reasons: [] }, columns: [{ key: "a:ext_ref", header: "Reference" }],
  groups: [], totals: [], output: { format: "csv", fileName: "{recon}_{from}_{to}", masking: "masked" }, when: { afterRun: true, onRequest: true }, official: false, ...o,
});
const why = (o: Record<string, unknown>) => ReportSpec.safeParse(spec(o)).error?.issues.map((i) => i.message);

describe("report limits and file names", () => {
  it("are the spec's", () => { expect([REPORT_RANGE_MAX_DAYS, PDF_ROWS_MAX, XLSX_ROWS_MAX]).toEqual([92, 5000, 1048576]); });
  it("fill the tokens and keep the name safe", () => {
    expect(fileNameOf("{recon}_{from}_{to}", t)).toBe("KSEI-vs-Core_2026-11-01_2026-11-24");
    expect(fileNameOf("{template}_{date}", { ...t, to: t.from })).toBe("Daily-recap_2026-11-01");
    expect(fileNameOf("{x}/../{recon}", t)).toBe("x-..-KSEI-vs-Core");
  });
});

describe("ReportSpec", () => {
  it("takes a plain spec", () => { expect(ReportSpec.safeParse(spec()).success).toBe(true); });
  it("full customer data needs an official report; groups are for a grouped one; it is made at least one way", () => {
    expect(why({ output: { format: "csv", fileName: "x", masking: "full" } })).toEqual(["Full customer data needs an official report."]);
    expect(why({ groups: ["a:ext_ref"] })).toEqual(["Group rows only in a grouped report."]);
    expect(why({ when: { afterRun: false, onRequest: false } })).toEqual(["Make it after every run, on request, or both."]);
    expect(ReportSpec.safeParse(spec({ kind: "grouped", groups: ["a:ext_ref", "recon:status", "b:x"] })).success).toBe(false);
  });
});

describe("report permissions", () => {
  it("full customer data is for a space admin, a reviewer and a config checker", () => {
    expect(["space_admin", "reviewer", "config_checker", "operator", "config_maker", "viewer"].map((r) => mayDo([r as never], "downloadFullReports"))).toEqual([true, true, true, false, false, false]);
    expect(mayDo(["viewer"], "viewReports")).toBe(true);
    expect(mayDo(["operator"], "editReports")).toBe(false);
  });
});
