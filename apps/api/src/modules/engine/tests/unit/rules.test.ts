// The schedule's pure rules (rules.ts): close moments, the dates a scheduled run covers, freshness.
import { describe, expect, it } from "bun:test";
import { closeMoment, isStale, lastDue, planRun, staleAlert } from "../../rules";

const interval = { close_at: "23:00", schedule: { kind: "interval" as const, every_minutes: 2 } };
const daily = { close_at: "23:00", schedule: { kind: "daily" as const, at: "06:00", business_date_offset: 1 } };
const at = (s: string) => new Date(`${s}+07:00`);
const none = { lastClosed: null, firstDate: "2026-11-02", lastStarted: null };

describe("close moments", () => {
  it("interval: close_at on the date; daily: the run time on date + offset", () => {
    expect(closeMoment(interval, "2026-11-02").toISOString()).toBe("2026-11-02T16:00:00.000Z");
    expect(closeMoment(daily, "2026-11-02").toISOString()).toBe("2026-11-02T23:00:00.000Z"); // 3 Nov 06:00 WIB
    expect(lastDue(interval, at("2026-11-02T22:59:00"))).toBe("2026-11-01");
    expect(lastDue(interval, at("2026-11-02T23:00:00"))).toBe("2026-11-02");
    expect(lastDue(daily, at("2026-11-03T05:59:00"))).toBe("2026-11-01");
    expect(lastDue(daily, at("2026-11-03T06:00:00"))).toBe("2026-11-02");
  });
});

describe("planRun", () => {
  it("interval: today, every every_minutes since the last scheduled run, and at once when a date waits to close", () => {
    const now = at("2026-11-02T10:00:00");
    expect(planRun(interval, none, now)).toEqual({ from: "2026-11-02", to: "2026-11-02" });
    expect(planRun(interval, { ...none, lastStarted: at("2026-11-02T09:59:00") }, now)).toBeNull();
    expect(planRun(interval, { ...none, lastStarted: at("2026-11-02T09:58:00") }, now)).toEqual({ from: "2026-11-02", to: "2026-11-02" });
    // the 2nd closes at 23:00: due at once, whatever the last run
    expect(planRun(interval, { ...none, lastStarted: at("2026-11-02T23:00:00") }, at("2026-11-02T23:00:30"))).toEqual({ from: "2026-11-02", to: "2026-11-02" });
    // closed today: nothing until tomorrow
    expect(planRun(interval, { ...none, lastClosed: "2026-11-02" }, at("2026-11-02T23:30:00"))).toBeNull();
  });

  it("catch-up from state: from the day after the last closed one, 30 days back at most, 31 dates per run", () => {
    expect(planRun(interval, { ...none, lastClosed: "2026-11-02" }, at("2026-11-05T10:00:00"))).toEqual({ from: "2026-11-03", to: "2026-11-05" });
    expect(planRun(daily, { ...none, lastClosed: "2026-11-02" }, at("2026-11-06T07:00:00"))).toEqual({ from: "2026-11-03", to: "2026-11-05" });
    expect(planRun(interval, { ...none, firstDate: "2026-01-01" }, at("2026-11-21T10:00:00"))).toEqual({ from: "2026-10-22", to: "2026-11-21" });
    expect(planRun(daily, { ...none, firstDate: "2026-09-01" }, at("2026-11-21T07:00:00"))).toEqual({ from: "2026-10-22", to: "2026-11-20" });
  });

  it("daily: due while the last date whose run time passed is not closed", () => {
    expect(planRun(daily, { ...none, lastClosed: "2026-11-01" }, at("2026-11-03T05:00:00"))).toBeNull();
    expect(planRun(daily, { ...none, lastClosed: "2026-11-01" }, at("2026-11-03T06:00:00"))).toEqual({ from: "2026-11-02", to: "2026-11-02" });
    expect(planRun(daily, { ...none, lastClosed: "2026-11-02" }, at("2026-11-03T06:01:00"))).toBeNull();
  });
});

describe("planRun: waiting and backoff (review round 1)", () => {
  it("a date waiting for data that hasn't moved starts no run but an interval recon's own ticks", () => {
    const closing = { ...none, lastStarted: at("2026-11-02T23:00:00"), waiting: true };
    expect(planRun(daily, { ...none, lastClosed: "2026-11-01", waiting: true }, at("2026-11-03T06:30:00"))).toBeNull();
    expect(planRun(interval, closing, at("2026-11-02T23:01:00"))).toBeNull();
    expect(planRun(interval, closing, at("2026-11-02T23:02:00"))).toEqual({ from: "2026-11-02", to: "2026-11-02" });
  });

  it("a failed last run waits its interval, 15 minutes at least", () => {
    const failed = { ...none, lastStarted: at("2026-11-02T10:00:00"), lastFailed: true };
    expect(planRun(interval, failed, at("2026-11-02T10:14:59"))).toBeNull();
    expect(planRun(interval, failed, at("2026-11-02T10:15:00"))).toEqual({ from: "2026-11-02", to: "2026-11-02" });
  });
});

describe("freshness", () => {
  it("logs when a recon becomes stale, then hourly; never while there is nothing to run", () => {
    const success = at("2026-11-02T10:00:00"); // stale from 10:04
    expect(staleAlert(interval, success, null, at("2026-11-02T10:04:30"))).toBe(true);
    expect(staleAlert(interval, success, null, at("2026-11-02T10:05:30"))).toBe(false);
    expect(staleAlert(interval, success, null, at("2026-11-02T11:04:30"))).toBe(true);
    expect(staleAlert(interval, success, "2026-11-02", at("2026-11-02T11:04:30"))).toBe(false);
  });

  it("stale past twice the interval (a daily recon: two days)", () => {
    const now = at("2026-11-02T10:00:00");
    expect(isStale(interval, at("2026-11-02T09:56:00"), now)).toBe(false);
    expect(isStale(interval, at("2026-11-02T09:55:59"), now)).toBe(true);
    expect(isStale(daily, at("2026-10-31T10:00:00"), now)).toBe(false);
    expect(isStale(daily, at("2026-10-31T09:59:59"), now)).toBe(true);
  });
});
