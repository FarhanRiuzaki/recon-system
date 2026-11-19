// sourceHealth (Build notes 02, spec §8): completeness of the business date in progress, which it works out itself
// from the source's calendar and now (Asia/Jakarta).
import { describe, expect, it } from "bun:test";
import { type HealthSource, sourceHealth } from "../../health";
import { makeCalendar } from "../../map";

const cal = makeCalendar({ weekend: [6, 7], holidays: [] });
const NOW = new Date("2026-11-03T03:00:00Z"); // Tue 3 Nov, 10:00 WIB: the date in progress of a daily source is Mon 2 Nov
const min = (n: number) => new Date(NOW.getTime() - n * 60_000);
const watermark = (o: Partial<HealthSource> = {}): HealthSource => ({
  kind: "db_watermark", status: "active", lastError: null, completeThrough: min(1), calendar: cal, latestActiveDate: null,
  graceSeconds: 600, deadline: null, ...o,
});
const snapshot = (o: Partial<HealthSource> = {}): HealthSource => ({
  kind: "db_snapshot", status: "active", lastError: null, completeThrough: new Date("2026-11-02T17:00:00Z"), calendar: cal,
  latestActiveDate: "2026-11-02", graceSeconds: 600, deadline: new Date("2026-11-03T05:00:00Z"), ...o,
});

describe("sourceHealth: a pulled source (watermark) by lag against the grace", () => {
  it("healthy within half the grace, degraded past half, down past the grace; date, lag and complete_through in the answer", () => {
    expect(sourceHealth(watermark(), NOW)).toEqual({ state: "healthy", businessDate: "2026-11-03", lagSeconds: 60, completeThrough: min(1).toISOString(), reason: null });
    expect(sourceHealth(watermark({ completeThrough: min(6) }), NOW)).toMatchObject({ state: "degraded", lagSeconds: 360 });
    expect(sourceHealth(watermark({ completeThrough: min(11) }), NOW)).toMatchObject({ state: "down", lagSeconds: 660 });
  });
  it("nothing pulled yet is degraded; no grace set (no recon reads it yet) leaves the lag unjudged", () => {
    expect(sourceHealth(watermark({ completeThrough: null }), NOW)).toMatchObject({ state: "degraded", lagSeconds: null, completeThrough: null });
    expect(sourceHealth(watermark({ completeThrough: min(600), graceSeconds: null }), NOW)).toMatchObject({ state: "healthy", lagSeconds: 36_000 });
  });
});

describe("sourceHealth: a source per business date (snapshot, file) by the business day before today", () => {
  it("active for that date: healthy, also when the last re-pull failed", () => {
    expect(sourceHealth(snapshot(), NOW)).toMatchObject({ state: "healthy", businessDate: "2026-11-02" });
    expect(sourceHealth(snapshot({ lastError: "The server did not answer within 120 s." }), NOW).state).toBe("healthy");
  });
  it("not active yet: degraded before the daily deadline, down from it, with the date in the reason", () => {
    expect(sourceHealth(snapshot({ latestActiveDate: "2026-10-30" }), NOW)).toMatchObject({ state: "degraded", reason: "No active snapshot for 2026-11-02" });
    expect(sourceHealth(snapshot({ latestActiveDate: null, deadline: NOW }), NOW)).toMatchObject({ state: "down", reason: "No active snapshot for 2026-11-02" });
    expect(sourceHealth(snapshot({ kind: "file_inbox", latestActiveDate: null, deadline: null }), NOW)).toMatchObject({ state: "degraded", reason: "No ingested file for 2026-11-02" });
  });
  it("over a weekend: on Saturday and on Monday morning the date in progress is Friday", () => {
    const fri = "2026-11-06";
    for (const at of ["2026-11-07T03:00:00Z", "2026-11-09T01:00:00Z"]) { // Sat 10:00 WIB, Mon 08:00 WIB
      expect(sourceHealth(snapshot({ latestActiveDate: fri, deadline: null }), new Date(at))).toMatchObject({ state: "healthy", businessDate: fri });
      expect(sourceHealth(snapshot({ latestActiveDate: "2026-11-05", deadline: null }), new Date(at))).toMatchObject({ state: "degraded", reason: `No active snapshot for ${fri}` });
    }
    // Monday after 00:00 WIB is still Sunday in UTC: the zone is Jakarta's, not the server's
    expect(sourceHealth(snapshot({ latestActiveDate: fri, deadline: null }), new Date("2026-11-08T17:30:00Z")).businessDate).toBe(fri);
  });
});

describe("sourceHealth: a paused source", () => {
  it("is down with its last error, whatever its data", () => {
    expect(sourceHealth(snapshot({ status: "paused", lastError: "Column \"sid\" is no longer in the query." }), NOW))
      .toMatchObject({ state: "down", reason: "Column \"sid\" is no longer in the query." });
    expect(sourceHealth(watermark({ status: "paused", lastError: null }), NOW)).toMatchObject({ state: "down", reason: "Paused" });
  });
});
