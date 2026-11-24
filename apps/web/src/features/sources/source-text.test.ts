import { describe, expect, it } from "vitest";
import type { SourceFileDto, SourceSnapshotDto } from "@starterkit/shared/contracts/sources";
import type { SourceSpec } from "@starterkit/shared/contracts/sources";
import { afterColon, completeText, errorSentence, fileResult, keptSnapshot, lagText, lookbackText, missingText, scheduleText, shortSha, specWatermarkKind, withDays } from "./source-text";

const h = (o: Partial<{ state: "healthy" | "degraded" | "down"; reason: string | null; missingDate: string | null; completeThrough: string | null; lagSeconds: number | null; lastError: string | null }>) =>
  ({ state: "healthy" as const, businessDate: "2026-11-04", lagSeconds: null, completeThrough: null, reason: null, missingDate: null, lastError: null, lastReadAt: null, ...o });

describe("source text (display only: the API judged the health)", () => {
  it("complete through: the API's reason for a date not delivered; else to the minute (pull) or the date (per date)", () => {
    expect(completeText({ kind: "file_inbox", health: null })).toBe("Not ingesting yet");
    // the API's missingDate decides it, never the reason's wording
    expect(completeText({ kind: "db_snapshot", health: h({ state: "degraded", reason: "anything", missingDate: "2026-11-04" }) })).toBe("No active snapshot for 4 Nov");
    expect(completeText({ kind: "file_inbox", health: h({ state: "down", reason: "anything", missingDate: "2026-11-04" }) })).toBe("No ingested file for 4 Nov");
    expect(completeText({ kind: "file_inbox", health: h({ state: "degraded", reason: "No something", completeThrough: "2026-11-03T17:00:00.000Z" }) })).toBe("Through 3 Nov");
    // complete_through of a date delivered per date is the end of that date (00:00 WIB the next day)
    expect(completeText({ kind: "file_inbox", health: h({ completeThrough: "2026-11-03T17:00:00.000Z" }) })).toBe("Through 3 Nov");
    expect(completeText({ kind: "db_watermark", health: h({ completeThrough: "2026-11-19T07:03:00.000Z" }) })).toBe("Through 19 Nov, 14:03 WIB");
    expect(lagText({ kind: "db_watermark", health: h({ lagSeconds: 1260 }) })).toBe("21 min behind");
    expect(lagText({ kind: "db_snapshot", health: h({ lagSeconds: 1260 }) })).toBeNull();
    expect(withDays("Snapshot 2026-11-04: lost")).toBe("Snapshot 4 Nov: lost");
  });

  it("files (Figma 95:8429): a resend names the file it repeats by its sha256; a version 2 says what it added", () => {
    const f = (o: Partial<SourceFileDto>): SourceFileDto => ({
      id: "f1", name: "act20261102.txt", sha256: "9f2c000000000000000000000000000000000000000000000000000000a71e", size: 1, status: "ingested", reason: null, version: 1,
      versionOf: null, businessDate: "2026-11-02", rowsTotal: 12, rowsOk: 10, rowsNew: 10, rowsQuarantined: 2, receivedAt: "2026-11-02T23:11:00.000Z", ...o,
    });
    expect(shortSha(f({}).sha256)).toBe("9f2c…a71e");
    expect(fileResult(f({ status: "rejected", versionOf: "f1" }), f({}))).toBe("Same content as the file from 3 Nov, 06:11 WIB; nothing changed.");
    expect(fileResult(f({ version: 2, rowsOk: 12, rowsNew: 2, rowsQuarantined: 0, receivedAt: "2026-11-04T01:40:00.000Z" }), undefined))
      .toBe("4 Nov, 08:40 WIB · version 2 of act20261102.txt · 2 new records, 10 already stored");
    expect(fileResult(f({}), undefined)).toBe("3 Nov, 06:11 WIB · 2 rows quarantined");
  });

  it("snapshots (27:7215, state b): a failed re-pull of a date with its active snapshot kept; none without one", () => {
    const s = (o: Partial<SourceSnapshotDto>): SourceSnapshotDto => ({ id: "s", businessDate: "2026-11-02", status: "active", rows: 11, error: null, startedAt: "2026-11-02T23:00:00.000Z", finishedAt: "2026-11-02T23:00:00.400Z", closed: false, ...o });
    const failed = s({ id: "f", status: "failed", rows: 6, error: "Lost after 6 of 11 rows.", startedAt: "2026-11-03T07:05:00.000Z" });
    expect(keptSnapshot([failed, s({})])).toBe("Showing the active snapshot for 2 Nov from 3 Nov, 06:00 WIB; the re-pull at 3 Nov, 14:05 WIB failed. Lost after 6 of 11 rows. Nothing was replaced.");
    expect(keptSnapshot([failed])).toBeNull();
  });

  it("no active snapshot (31:7924): the reason, the failure, the next scheduled pull (no automatic retry) and the deadline", () => {
    const text = missingText({
      kind: "db_snapshot",
      health: { ...h({ state: "degraded", reason: "No active snapshot for 2026-11-04", missingDate: "2026-11-04", lastError: "Snapshot 2026-11-04: The source refused (ORA-12541)." }), graceMinutes: null, deadline: "09:00" },
      nextRunAt: "2026-11-05T23:00:00.000Z",
    });
    expect(text).toBe("No active snapshot for 4 Nov. The last run failed. The source refused (ORA-12541). The next scheduled pull is at 6 Nov, 06:00 WIB. Pull now to retry sooner. Degraded until 09:00 WIB, the daily deadline, then Down.");
    expect(text).not.toMatch(/retr(y|ies) (every|in)/);
    // a file inbox is checked every minute: no "next scheduled pull"
    const file = missingText({ kind: "file_inbox", health: { ...h({ state: "degraded", missingDate: "2026-11-04" }), graceMinutes: null, deadline: null }, nextRunAt: "2026-11-05T23:00:00.000Z" });
    expect(file).toBe("No ingested file for 4 Nov. The folder is checked every minute.");
  });

  it("schedules as words for the crons sources use; any other cron as it is", () => {
    expect(scheduleText("0 6 * * *")).toBe("Daily at 06:00 WIB");
    expect(scheduleText("30 9 * * 1-5")).toBe("Weekdays at 09:30 WIB");
    expect(scheduleText("* * * * *")).toBe("Every minute");
    expect(scheduleText("0 */2 * * *")).toBe("Cron 0 */2 * * * (WIB)");
    expect(scheduleText("70 6 * * *")).toBe("Cron 70 6 * * * (WIB)");
  });

  it("composed messages: no capital after a colon, no repeated date lead", () => {
    expect(afterColon("Empty; ref can't be empty")).toBe("empty; ref can't be empty");
    expect(afterColon("ORA-01017 refused")).toBe("ORA-01017 refused");
    expect(errorSentence("Snapshot 2026-11-04: The connection was lost.")).toBe("The connection was lost.");
    expect(errorSentence("act20261104.txt: header changed on 2026-11-04")).toBe("act20261104.txt: header changed on 4 Nov");
  });
});

describe("look back (lookbackText): the value ingest uses, the default named when the spec leaves it out", () => {
  const wm = (o: Partial<Extract<SourceSpec["input"], { kind: "db_watermark" }>> = {}) => ({ kind: "db_watermark" as const, table: "t", watermark: { column: "u", id_columns: ["id"] }, chunk: 100, ...o });
  it("left out: a day for a date, none for a date and time, 1,000 ids for a sequence (lookbackOf's defaults)", () => {
    expect(lookbackText(wm(), "date")).toBe("1 day (default)");
    expect(lookbackText(wm(), "time")).toBe("None (default)");
    expect(lookbackText(wm(), "int")).toBe("1,000 ids (default)");
    expect(lookbackText(wm(), null)).toBe("The watermark's default: 1 day for a date, none for a date and time, 1,000 ids for a sequence");
  });
  it("set: seconds (whole days as days), ids, zero as none", () => {
    expect(lookbackText(wm({ lookback_seconds: 300 }), "time")).toBe("300 s");
    expect(lookbackText(wm({ lookback_seconds: 172_800 }), "date")).toBe("2 days");
    expect(lookbackText(wm({ lookback_seconds: 0 }), null)).toBe("None");
    expect(lookbackText(wm({ lookback_ids: 5000 }), "int")).toBe("5,000 ids");
    expect(lookbackText(wm({ lookback_ids: 0 }), "int")).toBe("None");
  });
  it("the watermark's kind from its field's type; Oracle's DATE holds a time", () => {
    const s = (type: "date" | "datetime" | "integer" | "string") => ({ fields: [{ name: "u", type, nullable: false, trim: false }], input: wm() }) as unknown as SourceSpec;
    expect(specWatermarkKind(s("date"), "postgres")).toBe("date");
    expect(specWatermarkKind(s("date"), "oracle")).toBe("time");
    expect(specWatermarkKind(s("datetime"), null)).toBe("time");
    expect(specWatermarkKind(s("integer"), null)).toBe("int");
    expect(specWatermarkKind(s("string"), null)).toBeNull();
  });
});
