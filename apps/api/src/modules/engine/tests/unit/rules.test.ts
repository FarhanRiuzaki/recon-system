// The schedule's pure rules (rules.ts, DEC-064): the date a recon works on, its run window and slots, freshness.
import { describe, expect, it } from "bun:test";
import { backoffMs, currentDate, planRun, slotAt, staleNow, windowOf } from "../../rules";

/** Garuda's shape: date D runs on D + 1, 07:00–16:00, every 60 minutes. */
const h1 = { schedule: { business_date_offset: 1, from: "07:00", to: "16:00", every_minutes: 60 } };
/** A real-time recon: today, all day, every 15 minutes. */
const live = { schedule: { business_date_offset: 0, from: "00:00", to: "23:59", every_minutes: 15 } };
/** Once a day: date D at D + 1 06:00. */
const once = { schedule: { business_date_offset: 1, from: "06:00", to: "06:00", every_minutes: 60 } };
const at = (s: string) => new Date(`${s}+07:00`);

describe("the date a recon works on and its window", () => {
  it("today − offset; the window on that date + offset, Asia/Jakarta", () => {
    expect(currentDate(h1, at("2026-11-27T00:30:00"))).toBe("2026-11-26");
    expect(currentDate(live, at("2026-11-27T00:30:00"))).toBe("2026-11-27");
    expect(windowOf(h1, "2026-11-26")).toEqual({ start: at("2026-11-27T07:00:00"), end: at("2026-11-27T16:00:00") });
  });

  it("slots: from, from + every, … to the window's last minute; none outside it", () => {
    expect(slotAt(h1, at("2026-11-27T06:59:00"))).toBeNull();
    expect(slotAt(h1, at("2026-11-27T07:00:00"))).toEqual(at("2026-11-27T07:00:00"));
    expect(slotAt(h1, at("2026-11-27T08:59:59"))).toEqual(at("2026-11-27T08:00:00"));
    expect(slotAt(h1, at("2026-11-27T16:00:30"))).toEqual(at("2026-11-27T16:00:00"));
    expect(slotAt(h1, at("2026-11-27T16:01:00"))).toBeNull();
    expect(slotAt(once, at("2026-11-27T06:00:00"))).toEqual(at("2026-11-27T06:00:00"));
    expect(slotAt(once, at("2026-11-27T06:01:00"))).toBeNull();
  });
});

describe("planRun", () => {
  it("the current date, once per slot of its window", () => {
    expect(planRun(h1, { lastStarted: null }, at("2026-11-27T07:00:20"))).toEqual({ from: "2026-11-26", to: "2026-11-26" });
    expect(planRun(h1, { lastStarted: at("2026-11-27T07:00:20") }, at("2026-11-27T07:30:00"))).toBeNull();
    expect(planRun(h1, { lastStarted: at("2026-11-27T07:00:20") }, at("2026-11-27T08:00:00"))).toEqual({ from: "2026-11-26", to: "2026-11-26" });
    // the last slot is at `to`; after it nothing until tomorrow's window (for the next date)
    expect(planRun(h1, { lastStarted: at("2026-11-27T15:00:10") }, at("2026-11-27T16:00:00"))).toEqual({ from: "2026-11-26", to: "2026-11-26" });
    expect(planRun(h1, { lastStarted: at("2026-11-27T16:00:10") }, at("2026-11-27T20:00:00"))).toBeNull();
    expect(planRun(h1, { lastStarted: at("2026-11-27T16:00:10") }, at("2026-11-28T07:00:00"))).toEqual({ from: "2026-11-27", to: "2026-11-27" });
    expect(planRun(live, { lastStarted: at("2026-11-27T10:00:05") }, at("2026-11-27T10:15:00"))).toEqual({ from: "2026-11-27", to: "2026-11-27" });
    expect(planRun(once, { lastStarted: null }, at("2026-11-27T06:00:00"))).toEqual({ from: "2026-11-26", to: "2026-11-26" });
  });

  it("a failed scheduled run waits its interval, 15 minutes at least, before the next", () => {
    expect(backoffMs(live)).toBe(15 * 60_000);
    expect(planRun(live, { lastStarted: at("2026-11-27T10:00:05"), lastFailed: true }, at("2026-11-27T10:15:00"))).toBeNull();
    expect(planRun(live, { lastStarted: at("2026-11-27T10:00:05"), lastFailed: true }, at("2026-11-27T10:30:00"))).toEqual({ from: "2026-11-27", to: "2026-11-27" });
  });
});

describe("freshness", () => {
  it("stale only while the window is on, after twice its interval without a success since the window started", () => {
    expect(staleNow(h1, at("2026-11-26T16:00:30"), at("2026-11-27T06:00:00"))).toBe(false); // before the window
    expect(staleNow(h1, at("2026-11-26T16:00:30"), at("2026-11-27T08:59:00"))).toBe(false); // < 2 h into it
    expect(staleNow(h1, at("2026-11-26T16:00:30"), at("2026-11-27T09:01:00"))).toBe(true);
    expect(staleNow(h1, at("2026-11-27T08:00:30"), at("2026-11-27T09:01:00"))).toBe(false);
    expect(staleNow(h1, null, at("2026-11-27T20:00:00"))).toBe(false); // after it
  });
});
