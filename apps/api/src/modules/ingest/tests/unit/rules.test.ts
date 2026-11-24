import { describe, expect, it } from "bun:test";
import { familyOf } from "../../connectors/dialect";
import { makeCalendar } from "../../map";
import { completedDates, completeThroughOf, cursorIds, deadlineOn, deliveryDue, type DeliveryFacts, deliveryOf, deliveryTally, driftOf, endOfDay, idText, nextRunOf, previousBusinessDay, todayIn } from "../../rules";

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
    // a date-only watermark: its date's start in the zone, less the look back (a day by default)
    expect(completeThroughOf("2026-11-20", 86_400)?.toISOString()).toBe("2026-11-18T17:00:00.000Z");
    expect(completeThroughOf("12345", 0)).toBeNull();
    expect(completeThroughOf("20261119", 0)).toBeNull(); // an integer watermark (a sequence) is no time, whatever its digits
  });
  it("idText and cursorIds: the ids kept with their column names; ids of other columns (renamed, reordered, another number) don't fit", () => {
    expect(idText(["id"], ["42"])).toBe('{"columns":["id"],"ids":["42"]}');
    expect(idText(["branch", "seq"], ["B01", "7"])).toBe('{"columns":["branch","seq"],"ids":["B01","7"]}');
    expect(cursorIds(idText(["id"], ["42"]), ["id"])).toEqual(["42"]);
    expect(cursorIds(idText(["branch", "seq"], ["a,b", '"q"']), ["branch", "seq"])).toEqual(["a,b", '"q"']);
    // the same number of id columns, other names or another order: none, so the pull resumes at the watermark (>=)
    expect(cursorIds(idText(["id"], ["42"]), ["ref"])).toBeNull();
    expect(cursorIds(idText(["branch", "seq"], ["B01", "7"]), ["seq", "branch"])).toBeNull();
    expect(cursorIds(idText(["branch", "seq"], ["B01", "7"]), ["branch"])).toBeNull();
    expect(cursorIds('{"columns":["id"],"ids":[42]}', ["id"])).toBeNull();
    // the older forms (no column names) are still read by their number: one id as plain text, several as a JSON array
    expect(cursorIds("42", ["id"])).toEqual(["42"]);
    expect(cursorIds('["x"]', ["id"])).toEqual(['["x"]']); // a text id that looks like JSON is still one id
    expect(cursorIds('["B01","7"]', ["branch", "seq"])).toEqual(["B01", "7"]);
    expect(cursorIds("42", ["a", "b"])).toBeNull();
    expect(cursorIds('["a","b","c"]', ["a", "b"])).toBeNull();
    expect(cursorIds('["a","b"]', ["a"])).toBeNull();
    expect(cursorIds('["a",7]', ["a", "b"])).toBeNull();
  });
  it("driftOf: a missing column, a nullable keyset column, a column that can't hold its field's type, a changed type; null when all fit", () => {
    const pg = (t: string) => familyOf("postgres", t);
    const cols = [{ name: "id", type: "bigint", nullable: false }, { name: "at", type: "timestamp with time zone", nullable: false }, { name: "amt", type: "numeric(18,2)", nullable: true }];
    const amt = [{ name: "amt", type: "decimal" as const }];
    expect(driftOf(cols, amt, ["at", "id"], [{ name: "amt", type: "numeric(18,2)" }], "table core.txn", pg)).toBeNull();
    expect(driftOf(cols, [...amt, { name: "ref", type: "string" }], ["at", "id"], null, "table core.txn", pg)?.message).toBe('Column "ref" is no longer in table core.txn. Make a new source version for the columns it has now.');
    expect(driftOf([cols[0]!, { ...cols[1]!, nullable: true }, cols[2]!], amt, ["at", "id"], null, "table t", pg)?.message).toMatch(/^Column "at" of table t may be empty/);
    // declared types against native ones, from the first pull: text for a decimal, a date for an integer
    const typed = [{ name: "amt", type: "text", nullable: true }, { name: "n", type: "date", nullable: true }, { name: "flag", type: "character(1)", nullable: true }];
    expect(driftOf(typed, [{ name: "amt", type: "decimal" }, { name: "n", type: "integer" }, { name: "flag", type: "boolean" }], [], null, "the query", pg)?.message).toBe(
      'Column "amt" of the query is text, which can\'t hold the field\'s type decimal; Column "n" of the query is date, which can\'t hold the field\'s type integer. Make a new source version for the columns it has now.');
    expect(driftOf(typed, [{ name: "amt", type: "string" }, { name: "n", type: "date" }], [], null, "the query", pg)).toBeNull(); // any column reads as text
    // a type that still fits but changed since the first pull of the version
    expect(driftOf([...cols.slice(0, 2), { name: "amt", type: "bigint", nullable: true }], amt, ["at", "id"], [{ name: "amt", type: "numeric(18,2)" }], "the query", pg)?.message)
      .toBe('Column "amt" changed from numeric(18,2) to bigint in the query. Make a new source version for the columns it has now.');
    // per column, for the detail's "What changed" table: expected by the version, found now (null = gone), the effect
    expect(driftOf(cols, [...amt, { name: "ref", type: "string" }], ["at", "id", "ref"], null, "t", pg)?.columns).toEqual([
      { column: "ref", expected: "string", found: null, effect: "The column is gone, so it can't be read. Renamed? Pick the new column in a new version." },
    ]);
    expect(driftOf(cols, [], ["gone"], null, "t", pg)?.columns[0]).toMatchObject({ column: "gone", expected: "watermark or id", found: null });
    expect(driftOf(typed, [{ name: "amt", type: "decimal" }], [], null, "t", pg)?.columns).toEqual([
      { column: "amt", expected: "decimal", found: "text", effect: "It can't hold a decimal; set the field's type in a new version." },
    ]);
    expect(driftOf([...cols.slice(0, 2), { name: "amt", type: "bigint", nullable: true }], amt, ["at", "id"], [{ name: "amt", type: "numeric(18,2)" }], "t", pg)?.columns)
      .toMatchObject([{ column: "amt", expected: "numeric(18,2)", found: "bigint" }]);
    expect(driftOf([cols[0]!, { ...cols[1]!, nullable: true }, cols[2]!], amt, ["at", "id"], null, "t", pg)?.columns)
      .toMatchObject([{ column: "at", expected: "never empty", found: "timestamp with time zone, may be empty" }]);
    // a query's columns say nothing about NULL (nullable null): not refused
    expect(driftOf(cols.map((c) => ({ ...c, nullable: null })), amt, ["at", "id"], null, "the query", pg)).toBeNull();
  });

  it("deadlineOn: HH:MM of a date in Asia/Jakarta (UTC+7, no daylight saving)", () => {
    expect(deadlineOn("2026-11-04", "09:00").toISOString()).toBe("2026-11-04T02:00:00.000Z");
    expect(deadlineOn("2026-11-04", "00:30").toISOString()).toBe("2026-11-03T17:30:00.000Z");
  });

  it("nextRunOf: the next occurrence of a cron after now, in Asia/Jakarta", () => {
    // 05 Nov 06:00 WIB has passed (it is 06:01): the next is 06 Nov 06:00 WIB
    expect(nextRunOf("0 6 * * *", new Date("2026-11-04T23:01:00Z")).toISOString()).toBe("2026-11-05T23:00:00.000Z");
    expect(nextRunOf("0 6 * * *", new Date("2026-11-04T22:00:00Z")).toISOString()).toBe("2026-11-04T23:00:00.000Z");
    expect(nextRunOf("* * * * *", new Date("2026-11-04T22:00:30Z")).toISOString()).toBe("2026-11-04T22:01:00.000Z");
  });
});

describe("source deliveries: on time, late, missing, unknown", () => {
  const jkt = (s: string) => new Date(`${s}+07:00`);
  it("completedDates: the dates whose end (Asia/Jakarta) a watermark pull just passed; none on the first pull or when it doesn't move", () => {
    expect(completedDates(new Date("2026-11-19T10:00:00Z"), new Date("2026-11-21T01:00:00Z"))).toEqual(["2026-11-19", "2026-11-20"]);
    expect(completedDates(jkt("2026-11-20T00:00:00"), jkt("2026-11-20T00:00:00"))).toEqual([]);
    expect(completedDates(jkt("2026-11-19T23:59:59"), jkt("2026-11-20T00:00:00"))).toEqual(["2026-11-19"]); // its end exactly
    expect(completedDates(null, new Date("2026-11-21T01:00:00Z"))).toEqual([]); // the first pull: those dates stay unknown
    expect(completedDates(new Date("2026-11-21T01:00:00Z"), new Date("2026-11-19T01:00:00Z"))).toEqual([]);
    const far = completedDates(new Date("2000-01-01T00:00:00Z"), new Date("2026-11-21T01:00:00Z"));
    expect([far.length, far.at(-1)]).toEqual([400, "2026-11-20"]); // bounded, the latest kept
  });
  it("deliveryDue: the source's own grace (pulled) or deadline (per date, on the day after), else the recon's, else the end of the next day", () => {
    const at = (kind: Parameters<typeof deliveryDue>[0], h: Parameters<typeof deliveryDue>[1], d: string, r: Date | null) => deliveryDue(kind, h, d, r).toISOString();
    expect(at("db_watermark", { graceMinutes: 30 }, "2026-11-02", null)).toBe(jkt("2026-11-03T00:30:00").toISOString());
    expect(at("file_inbox", { deadline: "09:00" }, "2026-11-02", jkt("2026-11-02T23:00:00"))).toBe(jkt("2026-11-03T09:00:00").toISOString());
    expect(at("db_snapshot", { deadline: "09:00" }, "2026-11-06", null)).toBe(jkt("2026-11-07T09:00:00").toISOString());
    // a pulled source's deadline and a per-date source's grace are not their rule: the recon's then, else the end of the next day
    expect(at("db_watermark", { deadline: "09:00" }, "2026-11-02", jkt("2026-11-03T06:30:00"))).toBe(jkt("2026-11-03T06:30:00").toISOString());
    expect(at("file_inbox", { graceMinutes: 30 }, "2026-11-02", null)).toBe(jkt("2026-11-04T00:00:00").toISOString());
    expect(at("file_inbox", undefined, "2026-11-02", null)).toBe(jkt("2026-11-04T00:00:00").toISOString());
  });
  it("deliveryOf: its first completion against the due time; complete with no completion kept = unknown; not complete past due = missing, before it not counted", () => {
    const due = jkt("2026-11-03T09:00:00"), now = jkt("2026-11-10T00:00:00");
    expect(deliveryOf(jkt("2026-11-03T09:00:00"), true, due, now)).toBe("on_time");
    expect(deliveryOf(jkt("2026-11-03T09:00:01"), true, due, now)).toBe("late");
    expect(deliveryOf(null, true, due, now)).toBe("unknown");
    expect(deliveryOf(null, false, due, now)).toBe("missing");
    expect(deliveryOf(null, false, due, jkt("2026-11-03T08:59:59"))).toBeNull();
    expect(deliveryOf(jkt("2026-11-03T08:00:00"), true, due, jkt("2026-11-03T08:30:00"))).toBe("on_time");
  });
  it("deliveryTally: the business dates of the source's calendar, due after the source was made; completeness per kind", () => {
    const cal = makeCalendar({ weekend: [6, 7], holidays: [] });
    const dates = ["2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10"]; // Fri, Sat, Sun, Mon, Tue
    const now = jkt("2026-11-20T00:00:00");
    const base: DeliveryFacts = {
      kind: "file_inbox", calendar: cal, createdAt: jkt("2026-11-01T00:00:00"), health: { deadline: "09:00" },
      completedAt: new Map([["2026-11-06", jkt("2026-11-07T08:00:00")], ["2026-11-09", jkt("2026-11-10T11:00:00")]]),
      delivered: new Set(["2026-11-06", "2026-11-09", "2026-11-10"]), completeThrough: null, untimed: false, reconDue: () => null,
    };
    expect(deliveryTally(base, dates, now)).toEqual({ onTime: 1, late: 1, missing: 0, unknown: 1 });
    expect(deliveryTally({ ...base, delivered: new Set(["2026-11-06", "2026-11-09"]) }, dates, now)).toEqual({ onTime: 1, late: 1, missing: 1, unknown: 0 });
    // made on Mon 9 Nov at noon: Friday's file was due before the source existed; Monday's (due Tue 09:00) counts
    expect(deliveryTally({ ...base, createdAt: jkt("2026-11-09T12:00:00") }, dates, now)).toEqual({ onTime: 0, late: 1, missing: 0, unknown: 1 });
    // a pulled source: complete once complete_through passed the date's end; a watermark that is no time gives no completeness
    const pulled: DeliveryFacts = { ...base, kind: "db_watermark", health: { graceMinutes: 60 }, completedAt: new Map([["2026-11-06", jkt("2026-11-07T00:30:00")]]), delivered: new Set(), completeThrough: jkt("2026-11-10T00:00:00") };
    expect(deliveryTally(pulled, dates, now)).toEqual({ onTime: 1, late: 0, missing: 1, unknown: 1 });
    expect(deliveryTally({ ...pulled, completedAt: new Map(), completeThrough: null, untimed: true }, dates, now)).toEqual({ onTime: 0, late: 0, missing: 0, unknown: 3 });
    expect(deliveryTally({ ...pulled, completedAt: new Map(), completeThrough: null }, dates, now)).toEqual({ onTime: 0, late: 0, missing: 3, unknown: 0 });
    // no own rule: the recon's due time
    expect(deliveryTally({ ...base, health: undefined, reconDue: (d) => jkt(`${d}T23:59:00`) }, dates, now)).toEqual({ onTime: 0, late: 2, missing: 0, unknown: 1 });
  });
});
