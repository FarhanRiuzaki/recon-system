// Source health (spec §8, Build notes 02): how complete a source's data is for the business date in progress. The one
// health rule of the product: the sources list and detail and the Space map all call sourceHealth, and the business
// date in progress is worked out here from the source's calendar and `now` (Asia/Jakarta), never by the caller, so
// two screens can't judge different dates.
//
// - A pulled source (db_watermark) is judged by its lag, now − complete_through, against the grace of the recons that
//   read it: past half the grace Degraded, past the grace Down. Its date in progress is today. With no grace set, its
//   lag is not judged, but a latest pull that failed (last_error) is Degraded with that error, so failing pulls show.
// - A source delivered per business date (db_snapshot, file_inbox) delivers date D on the next business morning
//   (KSEI: D's file and Medallion snapshot arrive on D+1), so its date in progress is the business day before today in
//   its calendar. It is judged by whether that date has an active snapshot (an ingested file): not yet → Degraded
//   until the recon's daily deadline, Down from it. Once the date is active, a failed re-pull leaves it Healthy (the
//   active snapshot stays; the failure shows on the detail). Its lag is shown, not judged: complete_through moves once
//   a day.
// - A paused source (its schema changed, spec §7 step 4) writes nothing: Down.
// Grace and deadline belong to the recon configs (Plan 3); null = none set yet, and that rule is left out.
import type { SourceHealthState, SourceKind, SourceStatus } from "@starterkit/shared/sources";
import type { Calendar } from "./map";
import { previousBusinessDay, todayIn } from "./rules";

export type HealthSource = {
  kind: SourceKind;
  status: SourceStatus;
  lastError: string | null;
  completeThrough: Date | null;
  /** The source's business-day calendar (its spec's `calendar`). */
  calendar: Calendar;
  /** The latest business date with an active snapshot (db_snapshot) or an ingested file (file_inbox); null = none. */
  latestActiveDate: string | null;
  graceSeconds: number | null;
  deadline: Date | null;
};
/** `missingDate`: the business date whose snapshot or file hasn't arrived (a source delivered per date), else null. */
export type SourceHealth = {
  state: SourceHealthState; businessDate: string; lagSeconds: number | null; completeThrough: string | null; reason: string | null; missingDate: string | null;
};

export function sourceHealth(s: HealthSource, now: Date): SourceHealth {
  const today = todayIn(now);
  const businessDate = s.kind === "db_watermark" ? today : previousBusinessDay(s.calendar, today);
  const lagSeconds = s.completeThrough ? Math.max(0, Math.floor((now.getTime() - s.completeThrough.getTime()) / 1000)) : null;
  const out = (state: SourceHealthState, reason: string | null, missingDate: string | null = null): SourceHealth =>
    ({ state, businessDate, lagSeconds, completeThrough: s.completeThrough?.toISOString() ?? null, reason, missingDate });
  if (s.status === "paused") return out("down", s.lastError ?? "Paused");
  if (s.kind === "db_watermark") {
    if (lagSeconds === null) return out("degraded", "Nothing pulled yet");
    if (s.graceSeconds === null) return s.lastError ? out("degraded", s.lastError) : out("healthy", null);
    if (lagSeconds > s.graceSeconds) return out("down", `Behind by more than the grace (${s.graceSeconds} s)`);
    if (lagSeconds > s.graceSeconds / 2) return out("degraded", `Behind by more than half the grace (${s.graceSeconds} s)`);
    return out("healthy", null);
  }
  if (s.latestActiveDate !== null && s.latestActiveDate >= businessDate) return out("healthy", null);
  const reason = `${s.kind === "db_snapshot" ? "No active snapshot" : "No ingested file"} for ${businessDate}`;
  return out(s.deadline && now >= s.deadline ? "down" : "degraded", reason, businessDate);
}
