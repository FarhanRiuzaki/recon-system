// Pure rules of the schedule (spec §9, Task 6; unit-tested): when a config's business date closes, which dates a
// scheduled run covers, and when a recon counts as stale. Times are Asia/Jakarta (UTC+7 all year).
import type { ReconSpec } from "@starterkit/shared/contracts/recon";
import { deadlineOn, todayIn } from "../ingest";

const DAY = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const maxDate = (a: string, b: string) => (a > b ? a : b);

/** How far back a run reaches (spec §10: the last 30 days) and how many dates one run covers (RUN_RANGE_MAX_DAYS). */
export const LOOKBACK_DAYS = 30;
const RANGE_DAYS = 31;

/**
 * The moment business date `d` closes: an interval config at its `close_at` on `d`; a daily config right after its run
 * for `d`, at `at` on `d` + business_date_offset (spec §9 "untuk daily = segera setelah run harian").
 */
export function closeMoment(spec: Pick<ReconSpec, "close_at" | "schedule">, d: string): Date {
  return spec.schedule.kind === "daily" ? deadlineOn(addDays(d, spec.schedule.business_date_offset), spec.schedule.at) : deadlineOn(d, spec.close_at);
}

/** The latest business date whose close moment is at or before `now`. */
export function lastDue(spec: Pick<ReconSpec, "close_at" | "schedule">, now: Date): string {
  const today = todayIn(now);
  const offset = spec.schedule.kind === "daily" ? spec.schedule.business_date_offset : 0;
  const d = addDays(today, -offset);
  return closeMoment(spec, d) <= now ? d : addDays(d, -1);
}

/**
 * What the schedule knows of a config: its last closed date, the date it was first published, its last scheduled run
 * (when it started, and whether it failed), and `waiting`: the oldest date due to close is closing for want of data,
 * no side's source moved since the last run's intake of it, and its close + grace hasn't come.
 */
export type ScheduleState = { lastClosed: string | null; firstDate: string; lastStarted: Date | null; lastFailed?: boolean; waiting?: boolean };

/** How long a config whose last scheduled run failed waits before the next: its interval, 15 minutes at least. */
export const backoffMs = (spec: Pick<ReconSpec, "schedule">) => Math.max(spec.schedule.kind === "interval" ? spec.schedule.every_minutes : 0, 15) * 60_000;

/**
 * The business dates a scheduled run of `spec` covers at `now`, or null when none is due. Catch-up comes from state:
 * the run starts the day after the last closed one (or the first publish date), never more than LOOKBACK_DAYS back,
 * and covers at most 31 dates (the next run takes the rest).
 * - interval: up to today, due every `every_minutes` since the last scheduled run started, and at once when a date's
 *   close moment has passed (unless it is waiting for data that hasn't moved);
 * - daily: up to the last date whose run time has passed, due while that date is not closed (and not waiting).
 * A config whose last scheduled run failed waits backoffMs from its start.
 */
export function planRun(spec: Pick<ReconSpec, "close_at" | "schedule">, s: ScheduleState, now: Date): { from: string; to: string } | null {
  if (s.lastFailed && s.lastStarted && now.getTime() - s.lastStarted.getTime() < backoffMs(spec)) return null;
  const today = todayIn(now);
  const from = maxDate(s.lastClosed ? addDays(s.lastClosed, 1) : s.firstDate, addDays(today, -LOOKBACK_DAYS));
  const due = lastDue(spec, now);
  let to: string;
  if (spec.schedule.kind === "daily") {
    if (due < from || s.waiting) return null;
    to = due;
  } else {
    if (today < from) return null;
    const every = !s.lastStarted || now.getTime() - s.lastStarted.getTime() >= spec.schedule.every_minutes * 60_000;
    if (!every && (due < from || s.waiting)) return null;
    to = today;
  }
  const last = addDays(from, RANGE_DAYS - 1);
  return { from, to: to > last ? last : to };
}

/**
 * Recon `spec` is stale at `now` (isStale, from `lastSuccess`) with something left to run: never an interval recon
 * whose today is closed, nor a daily one whose last due date is. Today shows it; the schedule alerts on it, once per
 * stale spell and then hourly (recon_alerts, schedule.ts dispatch).
 */
export function staleNow(spec: Pick<ReconSpec, "close_at" | "schedule">, lastSuccess: Date, lastClosed: string | null, now: Date): boolean {
  const idle = spec.schedule.kind === "interval" ? todayIn(now) : lastDue(spec, now);
  if (lastClosed && lastClosed >= idle) return false;
  return isStale(spec, lastSuccess, now);
}

/** A stale recon's alert repeats at most this often while it stays stale. */
export const ALERT_REPEAT_MS = 3_600_000;

/**
 * Freshness (spec §9): a recon is stale when its last successful scheduled run (or, before any, its first publish)
 * finished more than twice its interval ago (a daily recon: twice a day).
 */
export function isStale(spec: Pick<ReconSpec, "schedule">, lastSuccess: Date, now: Date): boolean {
  const interval = spec.schedule.kind === "interval" ? spec.schedule.every_minutes * 60_000 : DAY;
  return now.getTime() - lastSuccess.getTime() > 2 * interval;
}
