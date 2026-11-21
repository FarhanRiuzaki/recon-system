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
/** A last error as a sentence of its own: without the API's "Snapshot yyyy-mm-dd: " lead (the screen names the date). */
export const errorSentence = (text: string) => withDays(text.replace(/^Snapshot \d{4}-\d{2}-\d{2}: /, ""));
/** A reason after "column: ": lower case unless it starts with an acronym or a code ("Empty; …" → "empty; …"). */
export const afterColon = (text: string) => (/^[A-Z][a-z]/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text);

/** "The date's snapshot or file hasn't arrived": what the API's missingDate names, in the kind's words. */
export const missingLabel = (kind: SourceKind, date: string) => `${kind === "db_snapshot" ? "No active snapshot" : "No ingested file"} for ${day(date)}`;

const pad = (n: string) => n.padStart(2, "0");
/**
 * A schedule as words, for the crons sources use (minute and hour fixed, every day or Monday to Friday, or every
 * minute); any other cron is shown as it is.
 */
export function scheduleText(cron: string): string {
  if (cron.trim() === "* * * * *") return "Every minute";
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5)$/.exec(cron.trim());
  if (!m || Number(m[1]) > 59 || Number(m[2]) > 23) return `Cron ${cron} (${APP_TIME_ZONE_LABEL})`;
  return `${m[3] === "*" ? "Daily" : "Weekdays"} at ${pad(m[2]!)}:${pad(m[1]!)} ${APP_TIME_ZONE_LABEL}`;
}

/**
 * The "Complete through" cell: a date delivered per business date that hasn't arrived says so (the API's reason);
 * otherwise how far the data is complete: a pull to the minute, a date-delivered source to the date (its
 * complete_through is the end of that date, so the instant just before it).
 */
export function completeText(s: Pick<SourceRowDto, "kind" | "health">): string {
  const h = s.health;
  if (!h) return "Not ingesting yet";
  if (h.missingDate) return missingLabel(s.kind, h.missingDate);
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
    return `Same content as the file from ${first ? at(first.receivedAt) : "before"}; nothing changed.`;
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
    if (a) return `Showing the active snapshot for ${day(a.businessDate)} from ${at(a.finishedAt ?? a.startedAt)}; the re-pull at ${at(f.startedAt)} failed.${f.error ? ` ${errorSentence(f.error)}` : ""} Nothing was replaced.`;
  }
  return null;
}

/**
 * Figma 31:7924: which date hasn't arrived, the last failure, when it is tried again (no automatic retry in phase 1:
 * the next scheduled pull or Pull now; a file inbox is checked every minute) and, while Degraded with a deadline,
 * when it turns Down.
 */
export function missingText(s: Pick<SourceDto, "kind" | "health" | "nextRunAt">): string {
  const h = s.health!;
  const out = [`${missingLabel(s.kind, h.missingDate ?? h.businessDate)}.`];
  if (h.lastError) out.push(`The last run failed. ${errorSentence(h.lastError)}`);
  if (s.kind === "file_inbox") out.push("The folder is checked every minute.");
  else if (s.nextRunAt) out.push(`The next scheduled pull is at ${at(s.nextRunAt)}. Pull now to retry sooner.`);
  if (h.state === "degraded" && h.deadline) out.push(`Degraded until ${h.deadline} ${APP_TIME_ZONE_LABEL}, the daily deadline, then Down.`);
  return out.join(" ");
}

/** The tabs of a source's detail, in order (`?tab=`); the page reads them on the server, so they live outside the screen. */
export const SOURCE_TABS = ["overview", "records", "quarantine", "versions", "activity"] as const;
export type SourceTab = (typeof SOURCE_TABS)[number];
