import { describe, expect, it } from "bun:test";
import { makeCalendar } from "../../map";
import { completeThroughOf, driftOf, endOfDay, previousBusinessDay, todayIn } from "../../rules";

const cal = makeCalendar({ weekend: [6, 7], holidays: ["2026-11-02"] });

describe("ingest rules", () => {
  it("previousBusinessDay: Tuesday → Monday, Monday → Friday, past a holiday", () => {
    expect(previousBusinessDay(cal, "2026-11-04")).toBe("2026-11-03");
    expect(previousBusinessDay(cal, "2026-11-10")).toBe("2026-11-09");
    expect(previousBusinessDay(cal, "2026-11-03")).toBe("2026-10-30"); // Mon 2 Nov is a holiday
  });
  it("todayIn and endOfDay use Asia/Jakarta", () => {
    expect(todayIn(new Date("2026-11-02T18:00:00Z"))).toBe("2026-11-03");
    expect(endOfDay("2026-11-02").toISOString()).toBe("2026-11-02T17:00:00.000Z");
  });
  it("completeThroughOf: watermark − lookback, in the field's zone; null for a watermark that is no time", () => {
    expect(completeThroughOf("2026-11-19T00:00:10.000037Z", 10)?.toISOString()).toBe("2026-11-19T00:00:00.000Z");
    expect(completeThroughOf("2026-11-19T07:00:00", 0)?.toISOString()).toBe("2026-11-19T00:00:00.000Z");
    expect(completeThroughOf("2026-11-19T07:00:00", 0, { name: "u", type: "datetime", nullable: false, trim: true, format: { timezone: "UTC" } })?.toISOString())
      .toBe("2026-11-19T07:00:00.000Z");
    expect(completeThroughOf("12345", 0)).toBeNull();
  });
  it("driftOf: a missing column, a nullable keyset column, a changed type; null when all fit", () => {
    const cols = [{ name: "id", type: "bigint", nullable: false }, { name: "at", type: "timestamptz", nullable: false }, { name: "amt", type: "numeric", nullable: true }];
    expect(driftOf(cols, ["amt"], ["at", "id"], [{ name: "amt", type: "numeric" }], "table core.txn")).toBeNull();
    expect(driftOf(cols, ["amt", "ref"], ["at", "id"], null, "table core.txn")).toBe('Column "ref" is no longer in table core.txn. Make a new source version for the columns it has now.');
    expect(driftOf([...cols.slice(0, 1), { name: "at", type: "timestamptz", nullable: true }, cols[2]!], ["amt"], ["at", "id"], null, "table t")).toMatch(/^Column "at" of table t may be empty/);
    expect(driftOf(cols, ["amt"], ["at", "id"], [{ name: "amt", type: "text" }], "the query")).toBe('Column "amt" changed from text to numeric in the query. Make a new source version for the columns it has now.');
    // a query's columns say nothing about NULL (nullable null): not refused
    expect(driftOf(cols.map((c) => ({ ...c, nullable: null })), ["amt"], ["at", "id"], null, "the query")).toBeNull();
  });
});
