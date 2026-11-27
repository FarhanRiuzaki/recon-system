import { describe, expect, it } from "vitest";
import { COLUMN_NAME, DATE_STATES, HISTORY_SOURCE, BATCH_PREFIX, julianDate, RUN_TIME, SCHEDULER_STATES, STG_TABLE_NAME } from "./imports";
import { withViews } from "./permissions";

describe("import names", () => {
  it("a target table is stg_<name>_host in lower case, at most 63 characters", () => {
    for (const n of ["stg_kai_host", "stg_indovision_host", "stg_mnc_vision_host", "stg_a1_host"]) expect(STG_TABLE_NAME.test(n), n).toBe(true);
    for (const n of ["stg_host", "stg_Kai_host", "stg_kai_biller", "kai_host", "stg__kai_host", "stg_kai-x_host", `stg_${"x".repeat(55)}_host`]) {
      expect(STG_TABLE_NAME.test(n), n).toBe(false);
    }
    expect(STG_TABLE_NAME.test(`stg_${"x".repeat(54)}_host`)).toBe(true);
  });

  it("a column name is a lower case identifier", () => {
    for (const n of ["date", "ref_id", "tlbf05"]) expect(COLUMN_NAME.test(n), n).toBe(true);
    for (const n of ["Date", "1a", "a-b", "_a", "", "x".repeat(64)]) expect(COLUMN_NAME.test(n), n).toBe(false);
  });

  it("a history source is upper case like import-host's (KAI_TLHIST); a batch prefix the same with letters and digits", () => {
    for (const n of ["KAI_TLHIST", "INDOVISION_TLHIST", "GARUDA_TLHIST", "A1"]) expect(HISTORY_SOURCE.test(n), n).toBe(true);
    for (const n of ["kai_tlhist", "KAI TLHIST", "1KAI", "K", ""]) expect(HISTORY_SOURCE.test(n), n).toBe(false);
    expect(BATCH_PREFIX.test("HISTORY_TLHIST")).toBe(true);
    for (const n of ["HISTORY:TLHIST", "history", ""]) expect(BATCH_PREFIX.test(n), n).toBe(false);
  });

  it("a run time is HH:MM on the 24-hour clock", () => {
    for (const t of ["06:30", "00:00", "23:59"]) expect(RUN_TIME.test(t), t).toBe(true);
    for (const t of ["6:30", "24:00", "06:60", "0630"]) expect(RUN_TIME.test(t), t).toBe(false);
  });
});

describe("import vocabulary", () => {
  it("lists the monitor states of a date and of a scheduler", () => {
    expect(DATE_STATES).toEqual(["waiting", "not_ready", "imported", "late", "missing", "failed", "rerun"]);
    expect(SCHEDULER_STATES).toEqual(["ok", "missed", "stuck", "lock_left", "connection_failing", "off"]);
  });

  it("the julian MIS date is YYYYDDD, as HISTORY_TLHIST's clustered key", () => {
    expect(julianDate("2026-11-03")).toBe(2026307);
    expect(julianDate("2026-01-01")).toBe(2026001);
    expect(julianDate("2024-12-31")).toBe(2024366);
  });

  it("import.manage brings import.view", () => {
    expect([...withViews(["import.manage"])].sort()).toEqual(["import.manage", "import.view"]);
  });
});
