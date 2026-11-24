// Pure rules of the ingest pipeline (unit-tested): which business date a scheduled snapshot pulls, where completeness
// stands after a pull, a file or a snapshot, and whether a source's columns still are what its spec was approved on.
import type { FieldSpec } from "@starterkit/shared/contracts/sources";
import { CronExpressionParser } from "cron-parser";
import { coerce, DEFAULT_TIMEZONE } from "./coerce";
import type { Column } from "./connectors";
import type { Family } from "./connectors/dialect";
import type { Calendar } from "./map";

const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** Today's date in Asia/Jakarta as yyyy-mm-dd. */
export const todayIn = (now: Date, tz = DEFAULT_TIMEZONE): string => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(now);

/**
 * The business day before `today` in `calendar` (a snapshot scheduled on D+1 morning pulls D; Monday pulls Friday):
 * the latest date before today that is a business day itself (its index is above the day before's).
 */
export function previousBusinessDay(calendar: Calendar, today: string): string {
  let t = Date.parse(`${today}T00:00:00Z`) - DAY;
  for (let i = 0; i < 31; i++, t -= DAY) if (calendar.bdayIndex(iso(t)) > calendar.bdayIndex(iso(t - DAY))) return iso(t);
  return iso(Date.parse(`${today}T00:00:00Z`) - DAY); // a calendar with no business day in a month: the day before
}

/** The instant business date `date` ends in `tz` (midnight that starts the next day there). */
export function endOfDay(date: string, tz = DEFAULT_TIMEZONE): Date {
  const r = coerce(`${iso(Date.parse(`${date}T00:00:00Z`) + DAY)} 00:00:00`, { name: "d", type: "datetime", nullable: false, trim: true, format: { timezone: tz } });
  return new Date(r.ok ? (r.value as string) : `${date}T00:00:00Z`);
}

/**
 * complete_through of a watermark pull: the watermark − lookback, the watermark read as a date-time in the watermark
 * field's time zone when the spec declares one (else Asia/Jakarta, as coerce does). Null when the watermark is no
 * date-time (a sequence number): such a source has no time it is complete to. A date-only watermark reads as its
 * date's start. `lookbackSeconds` = the look back the pull used (connectors lookbackOf: a date-only one a day by default).
 */
export function completeThroughOf(watermark: string, lookbackSeconds: number, field?: FieldSpec): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}/.test(watermark)) return null; // the text form of a date or time (dialect.ts asText)
  const r = coerce(/^\d{4}-\d{2}-\d{2}$/.test(watermark) ? `${watermark}T00:00:00` : watermark, { name: "watermark", type: "datetime", nullable: false, trim: true, format: { timezone: field?.format?.timezone ?? DEFAULT_TIMEZONE } });
  return r.ok ? new Date(Date.parse(r.value as string) - lookbackSeconds * 1000) : null;
}

/** The last row's ids as source_cursors.watermark_id keeps them: JSON `{ columns, ids }`, the id columns' names with their texts. */
export const idText = (columns: string[], ids: string[]): string => JSON.stringify({ columns, ids });

const strings = (x: unknown): x is string[] => Array.isArray(x) && x.every((v) => typeof v === "string");

/**
 * The stored ids for id columns `columns`, or null when they don't fit (a new version picked other id columns: renamed,
 * reordered or another number of them): the pull then resumes at the watermark (`>=`), and dedup drops what comes
 * again. Older forms carry no names and are read by their number: one id as its plain text (before composite ids), several
 * as a JSON array of their texts.
 */
export function cursorIds(text: string, columns: string[]): string[] | null {
  let parsed: unknown = null;
  if (text.startsWith("[") || text.startsWith("{")) try { parsed = JSON.parse(text); } catch { /* a plain text id */ }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "columns" in parsed && "ids" in parsed) {
    const { columns: was, ids } = parsed as { columns: unknown; ids: unknown };
    return strings(was) && strings(ids) && ids.length === was.length && was.length === columns.length && was.every((c, j) => c === columns[j]) ? ids : null;
  }
  const list = strings(parsed) ? parsed : null;
  if (columns.length === 1) return list && list.length > 1 ? null : [text];
  return list && list.length === columns.length ? list : null;
}

export type Baseline = { name: string; type: string }[];

/** The native families (connectors/dialect.ts `familyOf`) a column may have for each declared logical type. */
const FITS: Record<FieldSpec["type"], Family[]> = {
  string: ["text", "int", "num", "date", "ts", "tstz", "bool"],
  integer: ["int", "num"],
  decimal: ["num", "int"],
  date: ["date", "ts", "tstz"],
  datetime: ["ts", "tstz", "date"],
  // a flag is often a CHAR(1) 'Y'/'N' or a 0/1 number in a bank's tables; coerce reads all of them
  boolean: ["bool", "int", "text"],
};
const NEW_VERSION = "Make a new source version for the columns it has now.";

/** One column a paused source no longer reads as its version expects: what the version expects, what is there now (null = gone) and the effect. */
export type DriftColumn = { column: string; expected: string; found: string | null; effect: string };
/** Why a source's columns no longer fit its spec: one sentence (its last error) and the columns behind it. */
export type Drift = { message: string; columns: DriftColumn[] };

/**
 * Why the source's columns no longer fit its spec, or null (spec §7 step 4): a declared field (or the watermark or id
 * column) missing; a watermark or id column that may be NULL (such a row would never be pulled: keyset paging skips
 * it); a column whose native type can't hold its field's logical type (text for a decimal, a date for an integer); or a
 * column whose native type changed since the first pull under this version (`baseline`). `family` = the engine's
 * familyOf.
 */
export function driftOf(cols: Column[], fields: Pick<FieldSpec, "name" | "type">[], keyset: string[], baseline: Baseline | null, where: string, family: (type: string) => Family): Drift | null {
  const byName = new Map(cols.map((c) => [c.name, c]));
  const typeOf = new Map(fields.map((f) => [f.name, f.type as string]));
  const quoted = (names: string[]) => names.map((n) => `"${n}"`).join(", ");
  const missing = [...new Set([...fields.map((f) => f.name), ...keyset])].filter((n) => !byName.has(n));
  if (missing.length) {
    return {
      message: `Column ${quoted(missing)} is no longer in ${where}. ${NEW_VERSION}`,
      columns: missing.map((n) => ({ column: n, expected: typeOf.get(n) ?? "watermark or id", found: null, effect: "The column is gone, so it can't be read. Renamed? Pick the new column in a new version." })),
    };
  }
  const nullable = keyset.filter((n) => byName.get(n)!.nullable === true);
  if (nullable.length) {
    return {
      message: `Column ${quoted(nullable)} of ${where} may be empty (nullable); a row without it would never be pulled. Use a watermark and id that are never empty.`,
      columns: nullable.map((n) => ({ column: n, expected: "never empty", found: `${byName.get(n)!.type}, may be empty`, effect: "A row without it would never be pulled. Use a watermark and id that are never empty." })),
    };
  }
  const misfit = fields.filter((f) => !FITS[f.type].includes(family(byName.get(f.name)!.type)));
  if (misfit.length) {
    return {
      message: `${misfit.map((f) => `Column "${f.name}" of ${where} is ${byName.get(f.name)!.type}, which can't hold the field's type ${f.type}`).join("; ")}. ${NEW_VERSION}`,
      columns: misfit.map((f) => ({ column: f.name, expected: f.type, found: byName.get(f.name)!.type, effect: `It can't hold a ${f.type}; set the field's type in a new version.` })),
    };
  }
  const changed = (baseline ?? []).filter((b) => byName.has(b.name) && byName.get(b.name)!.type !== b.type);
  if (changed.length) {
    return {
      message: `Column ${changed.map((b) => `"${b.name}" changed from ${b.type} to ${byName.get(b.name)!.type}`).join(", ")} in ${where}. ${NEW_VERSION}`,
      columns: changed.map((b) => ({ column: b.name, expected: b.type, found: byName.get(b.name)!.type, effect: "The type changed since this version's first pull; check the field's type and format in a new version." })),
    };
  }
  return null;
}

/** The instant `hhmm` (HH:MM) falls on `date` in Asia/Jakarta, which keeps UTC+7 all year (no daylight saving). */
export const deadlineOn = (date: string, hhmm: string): Date => new Date(`${date}T${hhmm}:00+07:00`);

/** The next occurrence of `cron` after `now`, evaluated in Asia/Jakarta as pg-boss does (kernel/jobs.ts JOB_TZ). */
export const nextRunOf = (cron: string, now: Date): Date => CronExpressionParser.parse(cron, { currentDate: now, tz: DEFAULT_TIMEZONE }).next().toDate();
