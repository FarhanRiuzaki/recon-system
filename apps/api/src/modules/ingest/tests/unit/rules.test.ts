import { describe, expect, it } from "bun:test";
import { familyOf } from "../../connectors/dialect";
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
  it("driftOf: a missing column, a nullable keyset column, a column that can't hold its field's type, a changed type; null when all fit", () => {
    const pg = (t: string) => familyOf("postgres", t);
    const cols = [{ name: "id", type: "bigint", nullable: false }, { name: "at", type: "timestamp with time zone", nullable: false }, { name: "amt", type: "numeric(18,2)", nullable: true }];
    const amt = [{ name: "amt", type: "decimal" as const }];
    expect(driftOf(cols, amt, ["at", "id"], [{ name: "amt", type: "numeric(18,2)" }], "table core.txn", pg)).toBeNull();
    expect(driftOf(cols, [...amt, { name: "ref", type: "string" }], ["at", "id"], null, "table core.txn", pg)).toBe('Column "ref" is no longer in table core.txn. Make a new source version for the columns it has now.');
    expect(driftOf([cols[0]!, { ...cols[1]!, nullable: true }, cols[2]!], amt, ["at", "id"], null, "table t", pg)).toMatch(/^Column "at" of table t may be empty/);
    // declared types against native ones, from the first pull: text for a decimal, a date for an integer
    const typed = [{ name: "amt", type: "text", nullable: true }, { name: "n", type: "date", nullable: true }, { name: "flag", type: "character(1)", nullable: true }];
    expect(driftOf(typed, [{ name: "amt", type: "decimal" }, { name: "n", type: "integer" }, { name: "flag", type: "boolean" }], [], null, "the query", pg)).toBe(
      'Column "amt" of the query is text, which can\'t hold the field\'s type decimal; Column "n" of the query is date, which can\'t hold the field\'s type integer. Make a new source version for the columns it has now.');
    expect(driftOf(typed, [{ name: "amt", type: "string" }, { name: "n", type: "date" }], [], null, "the query", pg)).toBeNull(); // any column reads as text
    // a type that still fits but changed since the first pull of the version
    expect(driftOf([...cols.slice(0, 2), { name: "amt", type: "bigint", nullable: true }], amt, ["at", "id"], [{ name: "amt", type: "numeric(18,2)" }], "the query", pg))
      .toBe('Column "amt" changed from numeric(18,2) to bigint in the query. Make a new source version for the columns it has now.');
    // a query's columns say nothing about NULL (nullable null): not refused
    expect(driftOf(cols.map((c) => ({ ...c, nullable: null })), amt, ["at", "id"], null, "the query", pg)).toBeNull();
  });
});
