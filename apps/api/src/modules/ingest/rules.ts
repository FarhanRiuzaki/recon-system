// Pure rules of the ingest pipeline (unit-tested): which business date a scheduled snapshot pulls, where completeness
// stands after a pull, a file or a snapshot, and whether a source's columns still are what its spec was approved on.
import type { FieldSpec } from "@starterkit/shared/contracts/sources";
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
 * date-time (a sequence number): such a source has no time it is complete to.
 */
export function completeThroughOf(watermark: string, lookbackSeconds: number, field?: FieldSpec): Date | null {
  const r = coerce(watermark, { name: "watermark", type: "datetime", nullable: false, trim: true, format: { timezone: field?.format?.timezone ?? DEFAULT_TIMEZONE } });
  return r.ok ? new Date(Date.parse(r.value as string) - lookbackSeconds * 1000) : null;
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

/**
 * Why the source's columns no longer fit its spec, or null (spec §7 step 4): a declared field (or the watermark or id
 * column) missing; a watermark or id column that may be NULL (such a row would never be pulled: keyset paging skips
 * it); a column whose native type can't hold its field's logical type (text for a decimal, a date for an integer); or a
 * column whose native type changed since the first pull under this version (`baseline`). `family` = the engine's
 * familyOf.
 */
export function driftOf(cols: Column[], fields: Pick<FieldSpec, "name" | "type">[], keyset: string[], baseline: Baseline | null, where: string, family: (type: string) => Family): string | null {
  const byName = new Map(cols.map((c) => [c.name, c]));
  const missing = [...fields.map((f) => f.name), ...keyset].filter((n) => !byName.has(n));
  if (missing.length) return `Column ${missing.map((n) => `"${n}"`).join(", ")} is no longer in ${where}. ${NEW_VERSION}`;
  const nullable = keyset.filter((n) => byName.get(n)!.nullable === true);
  if (nullable.length) return `Column ${nullable.map((n) => `"${n}"`).join(", ")} of ${where} may be empty (nullable); a row without it would never be pulled. Use a watermark and id that are never empty.`;
  const misfit = fields.filter((f) => !FITS[f.type].includes(family(byName.get(f.name)!.type)));
  if (misfit.length) return `${misfit.map((f) => `Column "${f.name}" of ${where} is ${byName.get(f.name)!.type}, which can't hold the field's type ${f.type}`).join("; ")}. ${NEW_VERSION}`;
  const changed = (baseline ?? []).filter((b) => byName.has(b.name) && byName.get(b.name)!.type !== b.type);
  if (changed.length) return `Column ${changed.map((b) => `"${b.name}" changed from ${b.type} to ${byName.get(b.name)!.type}`).join(", ")} in ${where}. ${NEW_VERSION}`;
  return null;
}
