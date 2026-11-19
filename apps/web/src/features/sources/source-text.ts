// Words the source screens show for what the API answers (Figma page 02, Build notes 02 "Final copy"). Display only:
// health, lag and completeness come judged from the API (sourceHealth); nothing here decides a state.
import { APP_TIME_ZONE_LABEL, appDayStart, formatDate, formatDateTime, formatDuration } from "@starterkit/ui/lib/format";
import type { SourceDto, SourceFileDto, SourceRowDto, SourceSnapshotDto } from "@starterkit/shared/contracts/sources";
import type { SourceKind } from "@starterkit/shared/sources";

export const KIND_LABEL: Record<SourceKind, string> = {
  file_inbox: "File inbox", db_watermark: "Database · watermark", db_snapshot: "Database · snapshot per date",
};

/** A business date ("2026-11-04") as the app writes dates ("4 Nov"). */
export const day = (date: string) => formatDate(appDayStart(date));
/** An instant with the app's zone ("4 Nov, 14:05 WIB"). */
export const at = (iso: string) => `${formatDateTime(Date.parse(iso))} ${APP_TIME_ZONE_LABEL}`;
/** The API's sentences carry business dates as yyyy-mm-dd; shown as the app writes dates. */
export const withDays = (text: string) => text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, day);

/**
 * The "Complete through" cell: a date delivered per business date that hasn't arrived says so (the API's reason);
 * otherwise how far the data is complete: a pull to the minute, a date-delivered source to the date (its
 * complete_through is the end of that date, so the instant just before it).
 */
export function completeText(s: Pick<SourceRowDto, "kind" | "health">): string {
  const h = s.health;
  if (!h) return "Not ingesting yet";
  if (s.kind !== "db_watermark" && h.reason?.startsWith("No ")) return withDays(h.reason);
  if (!h.completeThrough) return "Nothing complete yet";
  return s.kind === "db_watermark" ? `Through ${at(h.completeThrough)}` : `Through ${formatDate(Date.parse(h.completeThrough) - 1)}`;
}

/** A pulled source's lag ("21 min behind"); null for one delivered per date (its lag is shown, not judged, as a date). */
export const lagText = (s: Pick<SourceRowDto, "kind" | "health">) =>
  s.kind === "db_watermark" && s.health?.lagSeconds != null ? `${formatDuration(s.health.lagSeconds)} behind` : null;

/** A sha256 as the screens show it: its first and last 4 characters ("9f2c…a71e"). */
export const shortSha = (sha: string) => `${sha.slice(0, 4)}…${sha.slice(-4)}`;

/** A file's Result line (Figma 95:8429): what it added, or why it was rejected or failed. `first` = the file it repeats or follows. */
export function fileResult(f: SourceFileDto, first: SourceFileDto | undefined): string {
  if (f.status === "rejected") {
    return `Same file already ingested. Its sha256 (${shortSha(f.sha256)}) matches the file from ${first ? at(first.receivedAt) : "before"}; nothing changed.`;
  }
  if (f.status === "failed") return `${f.reason ?? "The file couldn't be read."} Nothing of it was written.`;
  const parts = [at(f.receivedAt)];
  if (f.version && f.version > 1) parts.push(`version ${f.version} of ${f.name}`, `${f.rowsNew} new records, ${f.rowsOk - f.rowsNew} already stored`);
  if (f.rowsQuarantined) parts.push(`${f.rowsQuarantined} ${f.rowsQuarantined === 1 ? "row" : "rows"} quarantined`);
  return parts.join(" · ");
}

/**
 * Figma 27:7215 (state b): the newest failed pull of a date that still has its active snapshot from before, on the
 * page shown; the active one stayed. Null when there is none.
 */
export function keptSnapshot(rows: readonly SourceSnapshotDto[]): string | null {
  for (const f of rows) {
    if (f.status !== "failed") continue;
    const a = rows.find((r) => r.status === "active" && r.businessDate === f.businessDate && r.startedAt < f.startedAt);
    if (a) return `Showing the active snapshot for ${day(a.businessDate)} from ${at(a.finishedAt ?? a.startedAt)}; the re-pull at ${at(f.startedAt)} failed${f.error ? `: ${f.error}` : "."} Nothing was replaced.`;
  }
  return null;
}

/**
 * Figma 31:7924: why a date delivered per business date isn't there yet, the last failure, the next scheduled run (no
 * automatic retry in phase 1: the next run or Pull now) and, while Degraded with a deadline, when it turns Down.
 */
export function missingText(s: Pick<SourceDto, "health" | "nextRunAt">): string {
  const h = s.health!;
  const out = [`${withDays(h.reason ?? "")}.`];
  if (h.lastError) out.push(`The last run failed: ${withDays(h.lastError)}`);
  if (s.nextRunAt) out.push(`The next scheduled pull is at ${at(s.nextRunAt)}. Pull now to retry sooner.`);
  if (h.state === "degraded" && h.deadline) out.push(`Degraded until ${h.deadline} ${APP_TIME_ZONE_LABEL}, the daily deadline, then Down.`);
  return out.join(" ");
}
