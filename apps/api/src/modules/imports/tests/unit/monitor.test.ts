import { describe, expect, it } from "bun:test";
import { CONNECTION_FAILED } from "@starterkit/shared/imports";
import { dateState, dueOf, type HistoryVersion, jakartaAt, type RunSeen, schedulerState, slotsBetween } from "../../rules";

const t = (iso: string) => new Date(iso);
const v = (status: HistoryVersion["status"], at: string, more: Partial<HistoryVersion> = {}): HistoryVersion => ({
  status, totalRows: status === "IMPORTED" ? 2 : null, errorMessage: null, createdAt: t(at), finishedAt: status === "PROCESSING" ? null : t(at), updatedAt: t(at), ...more,
});
// MIS date 2026-11-03 is due 2026-11-04 06:00 WIB + 30 min = 2026-11-03T23:30Z
const due = dueOf("2026-11-03", { time: "06:00", graceMinutes: 30 });
const before = t("2026-11-03T23:00:00Z");
const after = t("2026-11-04T01:00:00Z");

describe("dueOf and jakartaAt", () => {
  it("a MIS date is due the next day at the due time in Asia/Jakarta, plus the grace", () => {
    expect(due.toISOString()).toBe("2026-11-03T23:30:00.000Z");
    expect(jakartaAt("2026-11-30", "06:30").toISOString()).toBe("2026-11-29T23:30:00.000Z");
    expect(dueOf("2026-11-30", { time: "06:00", graceMinutes: 0 }).toISOString()).toBe("2026-11-30T23:00:00.000Z");
  });
});

describe("dateState", () => {
  const cell = (versions: HistoryVersion[], now = after, lastCheck: Parameters<typeof dateState>[0]["lastCheck"] = null) => dateState({ versions, lastCheck, due, now });

  it("nothing yet: waiting before the due time, missing after", () => {
    expect(cell([], before).state).toBe("waiting");
    expect(cell([], after)).toEqual({ state: "missing", rows: null, at: null, message: null });
  });

  it("a NOT READY check: not ready before the due time, still missing after it (with the check's time)", () => {
    const chk = { at: t("2026-11-03T22:45:00Z"), result: "not_ready" as const, message: null };
    expect(cell([], before, chk)).toMatchObject({ state: "not_ready", at: chk.at });
    expect(cell([], after, chk)).toMatchObject({ state: "missing", at: chk.at, message: "The source wasn't ready at the last check." });
  });

  it("imported on time or late, by the first time the date was imported (a superseded version with counts counts)", () => {
    expect(cell([v("IMPORTED", "2026-11-03T22:31:00Z")])).toMatchObject({ state: "imported", rows: 2 });
    expect(cell([v("IMPORTED", "2026-11-04T01:31:00Z")])).toMatchObject({ state: "late", at: t("2026-11-04T01:31:00Z") });
    const revised = [v("SUPERSEDED", "2026-11-03T22:31:00Z", { totalRows: 1 }), v("IMPORTED", "2026-11-04T03:00:00Z")];
    expect(cell(revised)).toMatchObject({ state: "imported", at: t("2026-11-03T22:31:00Z") });
    // a superseded FAILED try (no counts) doesn't make the date on time
    expect(cell([v("SUPERSEDED", "2026-11-03T22:31:00Z", { errorMessage: "x" }), v("IMPORTED", "2026-11-04T03:00:00Z")]).state).toBe("late");
  });

  it("FAILED then IMPORTED is imported; IMPORTED then a newer FAILED stays imported and says so", () => {
    expect(cell([v("SUPERSEDED", "2026-11-03T22:00:00Z", { errorMessage: "boom" }), v("IMPORTED", "2026-11-03T22:40:00Z")]).state).toBe("imported");
    const c = cell([v("IMPORTED", "2026-11-03T22:40:00Z"), v("FAILED", "2026-11-04T02:00:00Z", { errorMessage: "UNMAPPED 4625" })]);
    expect(c.state).toBe("imported");
    expect(c.message).toContain("UNMAPPED 4625");
  });

  it("failed with its error; rerun wins over everything; a SUPERSEDED-only date is missing", () => {
    expect(cell([v("FAILED", "2026-11-03T22:31:00Z", { errorMessage: "validation failed" })])).toMatchObject({ state: "failed", message: "validation failed" });
    expect(cell([v("RERUN", "2026-11-04T02:00:00Z", { totalRows: 2 })]).state).toBe("rerun");
    expect(cell([v("SUPERSEDED", "2026-11-03T22:31:00Z", { errorMessage: "released by retry" })]).state).toBe("missing");
  });

  it("a PROCESSING row is being loaded: waiting before the due time, missing after", () => {
    expect(cell([v("PROCESSING", "2026-11-03T22:31:00Z")], before)).toMatchObject({ state: "waiting", message: "Being loaded." });
    expect(cell([v("PROCESSING", "2026-11-03T22:31:00Z")], after).state).toBe("missing");
  });
});

describe("slotsBetween", () => {
  it("every run time in (from, to], across days, in Asia/Jakarta", () => {
    expect(slotsBetween(["06:30", "08:30"], t("2026-11-03T00:00:00Z"), t("2026-11-04T01:30:00Z")).map((d) => d.toISOString())).toEqual([
      "2026-11-03T01:30:00.000Z", "2026-11-03T23:30:00.000Z", "2026-11-04T01:30:00.000Z",
    ]);
    expect(slotsBetween([], t("2026-11-03T00:00:00Z"), t("2026-11-05T00:00:00Z"))).toEqual([]);
  });
});

describe("schedulerState", () => {
  const now = t("2026-11-04T00:00:00Z"); // 07:00 WIB: the 06:30 run is due, the 08:30 one isn't
  const run = (more: Partial<RunSeen>): RunSeen => ({ status: "done", scheduledFor: jakartaAt("2026-11-04", "06:30"), startedAt: t("2026-11-03T23:30:05Z"), heartbeatAt: t("2026-11-03T23:31:00Z"), ...more });
  // yesterday's 08:30 ran too (the last 24 hours are checked)
  const yesterday = run({ scheduledFor: jakartaAt("2026-11-03", "08:30"), startedAt: t("2026-11-03T01:30:05Z"), heartbeatAt: t("2026-11-03T01:31:00Z") });
  const base = { on: true, changedAt: t("2026-11-01T00:00:00Z"), times: ["06:30", "08:30"], maxMinutes: 30, runs: [yesterday, run({})], locks: [], lastCheck: null, now };

  it("ok, with the next run", () => {
    expect(schedulerState(base)).toEqual({ state: "ok", message: null, nextRun: jakartaAt("2026-11-04", "08:30") });
  });

  it("missed: a run time 10 minutes past with no run scheduled for it (a run that ran with nothing to do still counts)", () => {
    expect(schedulerState({ ...base, runs: [yesterday] })).toMatchObject({ state: "missed", message: "The 06:30 run didn't start." });
    expect(schedulerState({ ...base, runs: [yesterday], now: t("2026-11-03T23:35:00Z") }).state).toBe("ok"); // 06:35: within the grace
    expect(schedulerState({ ...base, runs: [], changedAt: t("2026-11-03T23:50:00Z") }).state).toBe("ok"); // turned on after 06:30
    expect(schedulerState({ ...base, runs: [run({})] })).toMatchObject({ state: "missed", message: "The 08:30 run didn't start." }); // yesterday's
  });

  it("stuck: a running run without a heartbeat for 2 minutes, or longer than maxMinutes", () => {
    expect(schedulerState({ ...base, runs: [yesterday, run({ status: "running", heartbeatAt: t("2026-11-03T23:57:00Z") })] }).state).toBe("stuck");
    expect(schedulerState({ ...base, runs: [yesterday, run({ status: "running", heartbeatAt: t("2026-11-03T23:59:40Z") })] }).state).toBe("ok");
    expect(schedulerState({ ...base, runs: [yesterday, run({ status: "running", startedAt: t("2026-11-03T23:20:00Z"), heartbeatAt: now })] }).state).toBe("stuck");
  });

  it("lock left: a PROCESSING row over 60 minutes old, also when the scheduler is off (import-host's)", () => {
    const locks = [{ fileDate: "2026-11-03", updatedAt: t("2026-11-03T22:00:00Z") }];
    expect(schedulerState({ ...base, locks })).toMatchObject({ state: "lock_left", message: "The batch of 2026-11-03 is still held by a run that stopped." });
    expect(schedulerState({ ...base, on: false, locks }).state).toBe("lock_left");
    expect(schedulerState({ ...base, locks: [{ fileDate: "2026-11-03", updatedAt: t("2026-11-03T23:30:00Z") }] }).state).toBe("ok");
  });

  it("off, with no next run; connection failing from the last check", () => {
    expect(schedulerState({ ...base, on: false, runs: [] })).toEqual({ state: "off", message: null, nextRun: null });
    const lastCheck = { at: now, result: "failed" as const, message: `${CONNECTION_FAILED} the DWH didn't answer within 30 s.` };
    expect(schedulerState({ ...base, lastCheck }).state).toBe("connection_failing");
    expect(schedulerState({ ...base, lastCheck: { ...lastCheck, message: "validation failed" } }).state).toBe("ok");
  });
});
