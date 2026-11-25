import { describe, expect, it } from "vitest";
import { fileNameOf, PDF_ROWS_MAX, REPORT_RANGE_MAX_DAYS, XLSX_ROWS_MAX } from "./reports";
import { mayDo } from "./spaces";

const t = { recon: "KSEI vs Core", template: "Daily recap", from: "2026-11-01", to: "2026-11-24" };

describe("report limits and file names", () => {
  it("are the spec's", () => { expect([REPORT_RANGE_MAX_DAYS, PDF_ROWS_MAX, XLSX_ROWS_MAX]).toEqual([92, 5000, 1048576]); });
  it("fill the tokens and keep the name safe", () => {
    expect(fileNameOf("{recon}_{from}_{to}", t)).toBe("KSEI-vs-Core_2026-11-01_2026-11-24");
    expect(fileNameOf("{template}_{date}", { ...t, to: t.from })).toBe("Daily-recap_2026-11-01");
    expect(fileNameOf("{x}/../{recon}", t)).toBe("x-..-KSEI-vs-Core");
  });
});

describe("report permissions", () => {
  it("full customer data is for a space admin, a reviewer and a config checker", () => {
    expect(["space_admin", "reviewer", "config_checker", "operator", "config_maker", "viewer"].map((r) => mayDo([r as never], "downloadFullReports"))).toEqual([true, true, true, false, false, false]);
    expect(mayDo(["viewer"], "viewReports")).toBe(true);
    expect(mayDo(["operator"], "editReports")).toBe(false);
  });
});
