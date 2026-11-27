import { describe, expect, it } from "bun:test";
import type { ImportFeedSpec } from "@starterkit/shared/contracts/imports";
import { blockers, feedChanges, renamesHistory } from "../../rules";

const watch: ImportFeedSpec = { kind: "db_host", historySource: "KAI_TLHIST", batchPrefix: "HISTORY_TLHIST", startDate: "2026-10-31", due: { time: "06:00", graceMinutes: 30 } };
const full: ImportFeedSpec = {
  ...watch, connectionId: "01900000-0000-7000-8000-000000000001", query: "the query",
  readinessQuery: "the readiness query",
  table: { name: "stg_kai_host", columns: [{ name: "x", type: "integer", required: true }], dedupe: [{ column: "x", normalize: false }] },
  mapping: [{ column: "x", expr: "row.x" }], schedule: { times: ["06:30"], maxMinutes: 30 },
};

describe("blockers: what keeps a feed's scheduler off", () => {
  it("a feed entered for Monitoring lists every missing part, in the order of the screen", () => {
    expect(blockers(watch, "missing")).toEqual([
      "Set the host connection.", "Write the query.", "Write the readiness query.", "Define the target table.", "Map the table's columns.", "Set the run times.",
    ]);
  });

  it("a complete spec still needs its table created or adopted", () => {
    expect(blockers(full, "missing")).toEqual(["Create or adopt the target table."]);
    expect(blockers(full, "created")).toEqual([]);
    expect(blockers(full, "adopted")).toEqual([]);
  });

  it("an empty mapping counts as missing", () => {
    expect(blockers({ ...full, mapping: [] }, "created")).toEqual(["Map the table's columns."]);
  });
});

describe("feedChanges", () => {
  it("only the fields that differ; the spec compared whole", () => {
    expect(feedChanges({ name: "KAI", spec: watch }, {})).toBeNull();
    expect(feedChanges({ name: "KAI", spec: watch }, { name: "KAI", spec: { ...watch } })).toBeNull();
    expect(feedChanges({ name: "KAI", spec: watch }, { name: "KAI host" })).toEqual({ before: { name: "KAI" }, after: { name: "KAI host" } });
    const due = { ...watch, due: { time: "07:00", graceMinutes: 30 } };
    expect(feedChanges({ name: "KAI", spec: watch }, { spec: due })).toEqual({ before: { spec: watch }, after: { spec: due } });
  });
});

describe("renamesHistory", () => {
  it("a different history source or batch prefix renames what history is keyed by; other fields don't", () => {
    expect(renamesHistory(watch, { ...watch, historySource: "KAI2_TLHIST" })).toBe(true);
    expect(renamesHistory(watch, { ...watch, batchPrefix: "TLHIST" })).toBe(true);
    expect(renamesHistory(watch, full)).toBe(false);
  });
});
