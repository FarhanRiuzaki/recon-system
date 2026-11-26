// Pure rules of the schedule (spec §9, DEC-064; unit-tested): which business date a recon works on now, its run window
// and the slot a scheduled run is due in, and when a recon counts as stale. There is no day close (DEC-064): a date is
// run again in every slot of its window, each run making what stays unpaired unmatch. Times are Asia/Jakarta (UTC+7
// all year).
import type { ReconSchedule } from "@starterkit/shared/contracts/recon";
import { deadlineOn, todayIn } from "../ingest";

const DAY = 86_400_000;
const MINUTE = 60_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

type Scheduled = { schedule: ReconSchedule };

/** The business date a recon's schedule works on at `now`: today − business_date_offset. */
export const currentDate = (spec: Scheduled, now: Date): string => addDays(todayIn(now), -spec.schedule.business_date_offset);

/** The run window of business date `d`: from `from` to `to` on d + business_date_offset (both ends inclusive, to the minute). */
export function windowOf(spec: Scheduled, d: string): { start: Date; end: Date } {
  const day = addDays(d, spec.schedule.business_date_offset);
  return { start: deadlineOn(day, spec.schedule.from), end: deadlineOn(day, spec.schedule.to) };
}

/**
 * The slot a scheduled run is due in at `now`: the latest of from, from + every, … at or before `now` within today's
 * window (its last minute included), or null outside the window.
 */
export function slotAt(spec: Scheduled, now: Date): Date | null {
  const w = windowOf(spec, currentDate(spec, now));
  if (now < w.start || now.getTime() >= w.end.getTime() + MINUTE) return null;
  const every = spec.schedule.every_minutes * MINUTE;
  return new Date(w.start.getTime() + Math.floor((now.getTime() - w.start.getTime()) / every) * every);
}

/** What the schedule knows of a config: its last scheduled run (when it started, and whether it failed). */
export type ScheduleState = { lastStarted: Date | null; lastFailed?: boolean };

/** How long a config whose last scheduled run failed waits before the next: its interval, 15 minutes at least. */
export const backoffMs = (spec: Scheduled) => Math.max(spec.schedule.every_minutes, 15) * MINUTE;

/**
 * The business dates a scheduled run of `spec` covers at `now`, or null when none is due: the current date, once per
 * slot of its window (no scheduled run started in this slot yet). A date whose window a stopped worker missed is still
 * read: the next date's runs take in its records through carry over. A config whose last scheduled run failed waits
 * backoffMs from its start.
 */
export function planRun(spec: Scheduled, s: ScheduleState, now: Date): { from: string; to: string } | null {
  const slot = slotAt(spec, now);
  if (!slot) return null;
  if (s.lastFailed && s.lastStarted && now.getTime() - s.lastStarted.getTime() < backoffMs(spec)) return null;
  if (s.lastStarted && s.lastStarted >= slot) return null;
  const d = currentDate(spec, now);
  return { from: d, to: d };
}

/** A stale recon's alert repeats at most this often while it stays stale. */
export const ALERT_REPEAT_MS = 3_600_000;

/**
 * Freshness (spec §9): while its run window is on, a recon is stale when no scheduled run succeeded for more than twice
 * its interval since the later of its last success and the window's start. Outside the window nothing is due, so
 * nothing is stale.
 */
export function staleNow(spec: Scheduled, lastSuccess: Date | null, now: Date): boolean {
  const w = windowOf(spec, currentDate(spec, now));
  if (now < w.start || now.getTime() >= w.end.getTime() + MINUTE) return false;
  const since = Math.max(lastSuccess?.getTime() ?? 0, w.start.getTime());
  return now.getTime() - since > 2 * spec.schedule.every_minutes * MINUTE;
}
