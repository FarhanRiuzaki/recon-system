// Pure rules of the Import section (unit-tested).
import type { ImportFeedPatchBody, ImportFeedSpec } from "@starterkit/shared/contracts/imports";
import { appDate, shiftDate } from "@starterkit/ui/lib/format";
import {
  CONNECTION_FAILED, type CheckResult, type DateState, HEARTBEAT_STALE_SECONDS, type HistoryStatus, LOCK_STALE_MINUTES, type RunStatus,
  type SchedulerState, START_GRACE_MINUTES,
} from "@starterkit/shared/imports";

/**
 * What still keeps a feed's scheduler from going on, as sentences for the screen (spec §4–§6); empty = complete.
 * Monitoring needs none of it: a feed is watched from its history source alone.
 */
export function blockers(spec: ImportFeedSpec, tableState: "missing" | "created" | "adopted"): string[] {
  const out: string[] = [];
  if (!spec.connectionId) out.push("Set the host connection.");
  if (!spec.query) out.push("Write the query.");
  if (!spec.readinessQuery) out.push("Write the readiness query.");
  if (!spec.table) out.push("Define the target table.");
  else if (tableState === "missing") out.push("Create or adopt the target table.");
  if (!spec.mapping?.length) out.push("Map the table's columns.");
  if (!spec.schedule) out.push("Set the run times.");
  return out;
}

type Editable = { name: string; spec: ImportFeedSpec };

/**
 * The fields of `b` that differ from `cur`, as the activity entry's before / after (changed fields only); null when
 * nothing changes. A spec is compared whole, as JSON.
 */
export function feedChanges(cur: Editable, b: ImportFeedPatchBody): { before: Partial<Editable>; after: Partial<Editable> } | null {
  const before: Partial<Editable> = {};
  const after: Partial<Editable> = {};
  if (b.name !== undefined && b.name !== cur.name) { before.name = cur.name; after.name = b.name; }
  if (b.spec !== undefined && JSON.stringify(b.spec) !== JSON.stringify(cur.spec)) { before.spec = cur.spec; after.spec = b.spec; }
  return Object.keys(after).length ? { before, after } : null;
}

/** Whether `next` renames what history is keyed by (refused once the feed has a history row). */
export const renamesHistory = (cur: ImportFeedSpec, next: ImportFeedSpec): boolean =>
  cur.historySource !== next.historySource || cur.batchPrefix !== next.batchPrefix;

// ---- Monitoring (spec §8): every state is read from rows, never guessed.

const MIN = 60_000;

/** HH:MM of `at` in Asia/Jakarta. */
const hhmm = (at: Date) => new Date(at.getTime() + 7 * 60 * MIN).toISOString().slice(11, 16);

/** `hhmm` on `date` in Asia/Jakarta (no daylight saving), as an instant. */
export const jakartaAt = (date: string, hhmm: string): Date => new Date(`${date}T${hhmm}:00+07:00`);

/** When MIS date `date` is due: the next day at `due.time` (Asia/Jakarta), plus the grace. */
export const dueOf = (date: string, due: { time: string; graceMinutes: number }): Date =>
  new Date(jakartaAt(shiftDate(date, 1), due.time).getTime() + due.graceMinutes * MIN);

export type HistoryVersion = {
  status: HistoryStatus; totalRows: number | null; errorMessage: string | null; createdAt: Date; finishedAt: Date | null; updatedAt: Date;
};
export type CheckSeen = { at: Date; result: CheckResult; message: string | null };
export type Cell = { state: DateState; rows: number | null; at: Date | null; message: string | null };

/**
 * One MIS date of a feed from its history versions (every status) and its latest check. Imported or late by the first
 * time the date was imported (an IMPORTED row, or a SUPERSEDED one that was: it has its counts), against the due time.
 */
export function dateState(o: { versions: HistoryVersion[]; lastCheck: CheckSeen | null; due: Date; now: Date }): Cell {
  const live = o.versions.filter((v) => v.status !== "SUPERSEDED");
  const imported = live.find((v) => v.status === "IMPORTED");
  const rerun = live.find((v) => v.status === "RERUN");
  if (rerun) return { state: "rerun", rows: imported?.totalRows ?? null, at: rerun.updatedAt, message: "Set to rerun: the next run loads it again." };
  if (imported) {
    const firsts = o.versions.filter((v) => v.finishedAt && (v.status === "IMPORTED" || (v.status === "SUPERSEDED" && v.totalRows !== null)))
      .map((v) => v.finishedAt!.getTime());
    const first = new Date(Math.min(...firsts, imported.finishedAt?.getTime() ?? imported.updatedAt.getTime()));
    const laterFailed = live.find((v) => v.status === "FAILED" && v.createdAt > imported.createdAt);
    return {
      state: first > o.due ? "late" : "imported", rows: imported.totalRows, at: first,
      message: laterFailed ? `A newer version failed and the imported one stays: ${laterFailed.errorMessage ?? "no message"}` : null,
    };
  }
  const failed = live.find((v) => v.status === "FAILED");
  if (failed) return { state: "failed", rows: null, at: failed.finishedAt ?? failed.updatedAt, message: failed.errorMessage };
  const loading = live.find((v) => v.status === "PROCESSING");
  const pastDue = o.now >= o.due;
  if (loading) return { state: pastDue ? "missing" : "waiting", rows: null, at: loading.createdAt, message: "Being loaded." };
  const notReady = o.lastCheck?.result === "not_ready" ? o.lastCheck : null;
  if (pastDue) return { state: "missing", rows: null, at: notReady?.at ?? null, message: notReady ? "The source wasn't ready at the last check." : null };
  if (notReady) return { state: "not_ready", rows: null, at: notReady.at, message: "The source wasn't ready at the last check." };
  return { state: "waiting", rows: null, at: null, message: null };
}

/** Every run time of `times` (HH:MM, Asia/Jakarta) after `from` and at or before `to`, oldest first. */
export function slotsBetween(times: readonly string[], from: Date, to: Date): Date[] {
  const out: Date[] = [];
  for (let d = appDate(from.getTime()); d <= appDate(to.getTime()); d = shiftDate(d, 1)) {
    for (const t of times) {
      const at = jakartaAt(d, t);
      if (at > from && at <= to) out.push(at);
    }
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

export type RunSeen = { status: RunStatus; scheduledFor: Date | null; startedAt: Date; heartbeatAt: Date };
export type LockSeen = { fileDate: string | null; updatedAt: Date };

/**
 * A feed's scheduler, the first that applies: a lock left in history (a PROCESSING row past LOCK_STALE_MINUTES, also
 * import-host's), a stuck run (heartbeat older than HEARTBEAT_STALE_SECONDS or longer than `maxMinutes`), off, a missed
 * run time (no run scheduled for it START_GRACE_MINUTES later, within the last day and since the scheduler last
 * changed), the source unreachable at the last check, else ok.
 */
export function schedulerState(o: {
  on: boolean; changedAt: Date | null; times: readonly string[]; maxMinutes: number;
  runs: RunSeen[]; locks: LockSeen[]; lastCheck: CheckSeen | null; now: Date;
}): { state: SchedulerState; message: string | null; nextRun: Date | null } {
  const now = o.now.getTime();
  const nextRun = o.on ? (slotsBetween(o.times, o.now, new Date(now + 2 * 24 * 60 * MIN))[0] ?? null) : null;
  const lock = o.locks.find((l) => now - l.updatedAt.getTime() > LOCK_STALE_MINUTES * MIN);
  if (lock) return { state: "lock_left", message: `The batch of ${lock.fileDate ?? "a date"} is still held by a run that stopped.`, nextRun };
  const stuck = o.runs.find((r) => r.status === "running"
    && (now - r.heartbeatAt.getTime() > HEARTBEAT_STALE_SECONDS * 1000 || now - r.startedAt.getTime() > o.maxMinutes * MIN));
  if (stuck) return { state: "stuck", message: "A run stopped answering, or is taking longer than the feed allows.", nextRun };
  if (!o.on) return { state: "off", message: null, nextRun };
  const since = Math.max(o.changedAt?.getTime() ?? 0, now - 24 * 60 * MIN);
  const started = new Set(o.runs.flatMap((r) => (r.scheduledFor ? [r.scheduledFor.getTime()] : [])));
  const missed = slotsBetween(o.times, new Date(since), new Date(now - START_GRACE_MINUTES * MIN)).filter((s) => !started.has(s.getTime())).at(-1);
  if (missed) return { state: "missed", message: `The ${hhmm(missed)} run didn't start.`, nextRun };
  if (o.lastCheck?.result === "failed" && o.lastCheck.message?.startsWith(CONNECTION_FAILED)) {
    return { state: "connection_failing", message: o.lastCheck.message, nextRun };
  }
  return { state: "ok", message: null, nextRun };
}
