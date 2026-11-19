// sourceHealth (Build notes 02, spec §8): completeness of the business date in progress.
import { describe, expect, it } from "bun:test";
import { type HealthSource, sourceHealth } from "../../health";

const NOW = new Date("2026-11-03T03:00:00Z"); // 10:00 WIB on D+1
const min = (n: number) => new Date(NOW.getTime() - n * 60_000);
const watermark = (o: Partial<HealthSource> = {}): HealthSource => ({
  kind: "db_watermark", status: "active", lastError: null, completeThrough: min(1), businessDate: "2026-11-03", activeForDate: false,
  graceSeconds: 600, deadline: null, ...o,
});
const snapshot = (o: Partial<HealthSource> = {}): HealthSource => ({
  kind: "db_snapshot", status: "active", lastError: null, completeThrough: new Date("2026-11-02T17:00:00Z"), businessDate: "2026-11-02",
  activeForDate: true, graceSeconds: 600, deadline: new Date("2026-11-03T05:00:00Z"), ...o,
});

describe("sourceHealth: a pulled source (watermark) by lag against the grace", () => {
  it("healthy within half the grace, degraded past half, down past the grace; lag and complete_through in the answer", () => {
    expect(sourceHealth(watermark(), NOW)).toEqual({ state: "healthy", lagSeconds: 60, completeThrough: min(1).toISOString(), reason: null });
    expect(sourceHealth(watermark({ completeThrough: min(6) }), NOW)).toMatchObject({ state: "degraded", lagSeconds: 360 });
    expect(sourceHealth(watermark({ completeThrough: min(11) }), NOW)).toMatchObject({ state: "down", lagSeconds: 660 });
  });
  it("nothing pulled yet is degraded; no grace set (no recon reads it yet) leaves the lag unjudged", () => {
    expect(sourceHealth(watermark({ completeThrough: null }), NOW)).toMatchObject({ state: "degraded", lagSeconds: null, completeThrough: null });
    expect(sourceHealth(watermark({ completeThrough: min(600), graceSeconds: null }), NOW)).toMatchObject({ state: "healthy", lagSeconds: 36_000 });
  });
});

describe("sourceHealth: a source per business date (snapshot, file) by its active data for the date in progress", () => {
  it("active for the date: healthy, also when the last re-pull failed", () => {
    expect(sourceHealth(snapshot(), NOW).state).toBe("healthy");
    expect(sourceHealth(snapshot({ lastError: "The server did not answer within 120 s." }), NOW).state).toBe("healthy");
  });
  it("not active yet: degraded before the daily deadline, down from it, with the date in the reason", () => {
    expect(sourceHealth(snapshot({ activeForDate: false }), NOW)).toMatchObject({ state: "degraded", reason: "No active snapshot for 2026-11-02" });
    expect(sourceHealth(snapshot({ activeForDate: false, deadline: NOW }), NOW)).toMatchObject({ state: "down", reason: "No active snapshot for 2026-11-02" });
    expect(sourceHealth(snapshot({ kind: "file_inbox", activeForDate: false, deadline: null }), NOW)).toMatchObject({ state: "degraded", reason: "No ingested file for 2026-11-02" });
  });
});

describe("sourceHealth: a paused source", () => {
  it("is down with its last error, whatever its data", () => {
    expect(sourceHealth(snapshot({ status: "paused", lastError: "Column \"sid\" is no longer in the query." }), NOW))
      .toMatchObject({ state: "down", reason: "Column \"sid\" is no longer in the query." });
    expect(sourceHealth(watermark({ status: "paused", lastError: null }), NOW)).toMatchObject({ state: "down", reason: "Paused" });
  });
});
