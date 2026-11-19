// Source health (spec §8, Build notes 02): how complete a source's data is for the business date in progress. The one
// health rule of the product: the sources list and detail and the Space map all call sourceHealth.
//
// - A pulled source (db_watermark) is judged by its lag, now − complete_through, against the grace of the recons that
//   read it: past half the grace Degraded, past the grace Down.
// - A source delivered per business date (db_snapshot, file_inbox) is judged by whether that date's snapshot is active
//   (its file ingested): not yet → Degraded until the recon's daily deadline, Down from it. Once the date is active, a
//   failed re-pull leaves it Healthy (the active snapshot stays; the failure shows on the detail). Its lag is shown,
//   not judged: complete_through moves once a day.
// - A paused source (its schema changed, spec §7 step 4) writes nothing: Down.
// Grace and deadline belong to the recon configs (Plan 3); null = none set yet, and that rule is left out.
import type { SourceHealthState, SourceKind, SourceStatus } from "@starterkit/shared/sources";

export type HealthSource = {
  kind: SourceKind;
  status: SourceStatus;
  lastError: string | null;
  completeThrough: Date | null;
  /** The business date in progress, and whether its snapshot is active (db_snapshot) or a file of it ingested (file_inbox). */
  businessDate: string;
  activeForDate: boolean;
  graceSeconds: number | null;
  deadline: Date | null;
};
export type SourceHealth = { state: SourceHealthState; lagSeconds: number | null; completeThrough: string | null; reason: string | null };

export function sourceHealth(s: HealthSource, now: Date): SourceHealth {
  const lagSeconds = s.completeThrough ? Math.max(0, Math.floor((now.getTime() - s.completeThrough.getTime()) / 1000)) : null;
  const out = (state: SourceHealthState, reason: string | null): SourceHealth => ({ state, lagSeconds, completeThrough: s.completeThrough?.toISOString() ?? null, reason });
  if (s.status === "paused") return out("down", s.lastError ?? "Paused");
  if (s.kind === "db_watermark") {
    if (lagSeconds === null) return out("degraded", "Nothing pulled yet");
    if (s.graceSeconds === null) return out("healthy", null);
    if (lagSeconds > s.graceSeconds) return out("down", `Behind by more than the grace (${s.graceSeconds} s)`);
    if (lagSeconds > s.graceSeconds / 2) return out("degraded", `Behind by more than half the grace (${s.graceSeconds} s)`);
    return out("healthy", null);
  }
  if (s.activeForDate) return out("healthy", null);
  const reason = `${s.kind === "db_snapshot" ? "No active snapshot" : "No ingested file"} for ${s.businessDate}`;
  return out(s.deadline && now >= s.deadline ? "down" : "degraded", reason);
}
