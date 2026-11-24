// Pure rules of the ingest pipeline (unit-tested): which business date a scheduled snapshot pulls, where completeness
// stands after a pull, a file or a snapshot, and whether a source's columns still are what its spec was approved on.
import type { FieldSpec, SourceSpec } from "@starterkit/shared/contracts/sources";
import type { SourceKind } from "@starterkit/shared/sources";
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

// ------------------------------------------------------------------------------------------------ deliveries
// A source's business date D is complete when its data for D is all in: a file of D ingested, D's snapshot active, or
// (a pulled source) complete_through past the end of D. It is due at the source's own rule (deliveryDue), and counts
// on time when it first became complete by then (source_deliveries), late after, missing when still not complete past
// it, unknown when complete with no completion kept (before the table existed, or a pull's first baseline). Only the
// business dates of the source's calendar count, and only those due after the source was made.

/** Dates a watermark pull may complete at once; a watermark that leaps further keeps the latest. */
const COMPLETED_MAX = 400;
/**
 * The dates D whose end (Asia/Jakarta) complete_through just passed, moving from `prev` to `next`: prev < end of D ≤
 * next, oldest first. None without `prev`: a source's first pull is its baseline, its dates stay unknown.
 */
export function completedDates(prev: Date | null, next: Date | null): string[] {
  if (!prev || !next || next <= prev) return [];
  const out: string[] = [];
  let d = todayIn(new Date(next.getTime() - 1)); // the date next falls in (its own end is after next, or equal at midnight)
  for (let i = 0; i < COMPLETED_MAX + 2 && out.length < COMPLETED_MAX; i++, d = iso(Date.parse(`${d}T00:00:00Z`) - DAY)) {
    const end = endOfDay(d);
    if (end <= prev) break;
    if (end <= next) out.push(d);
  }
  return out.reverse();
}

/**
 * When business date `date` of a source is due: its own rule (a pulled source's `graceMinutes` after the date's end,
 * the health's Down; a per-date source's `deadline` on the day after, when its file or snapshot of D arrives), else
 * `recon` (the earliest close + grace of the recons reading it, when they close D anyway), else the end of the next day.
 */
export function deliveryDue(kind: SourceKind, health: SourceSpec["health"], date: string, recon: Date | null): Date {
  const next = iso(Date.parse(`${date}T00:00:00Z`) + DAY);
  if (kind === "db_watermark" && health?.graceMinutes) return new Date(endOfDay(date).getTime() + health.graceMinutes * 60_000);
  if (kind !== "db_watermark" && health?.deadline) return deadlineOn(next, health.deadline);
  return recon ?? endOfDay(next);
}

export type Delivery = "on_time" | "late" | "missing" | "unknown";
/** One date: by its first completion `completedAt` against `due`; null = not complete and not due yet (not counted). */
export function deliveryOf(completedAt: Date | null, completeNow: boolean, due: Date, now: Date): Delivery | null {
  if (completedAt) return completedAt <= due ? "on_time" : "late";
  if (completeNow) return "unknown";
  return now >= due ? "missing" : null;
}

/**
 * What a source's deliveries rest on: its first completions by date, the dates with an ingested file or active
 * snapshot (`delivered`), its complete_through, and `untimed` = pulled with no complete_through (a watermark that is
 * no time: completeness unknown).
 */
export type DeliveryFacts = {
  kind: SourceKind; calendar: Calendar; createdAt: Date; health: SourceSpec["health"];
  completedAt: Map<string, Date>; delivered: Set<string>; completeThrough: Date | null; untimed: boolean;
  reconDue: (date: string) => Date | null;
};
export type DeliveryTally = { onTime: number; late: number; missing: number; unknown: number };
const TALLY_KEY = { on_time: "onTime", late: "late", missing: "missing", unknown: "unknown" } as const;

/** The deliveries of `dates` (yyyy-mm-dd) at `now`. */
export function deliveryTally(f: DeliveryFacts, dates: string[], now: Date): DeliveryTally {
  const out: DeliveryTally = { onTime: 0, late: 0, missing: 0, unknown: 0 };
  for (const d of dates) {
    if (f.calendar.bdayIndex(d) <= f.calendar.bdayIndex(iso(Date.parse(`${d}T00:00:00Z`) - DAY))) continue; // not a business day
    const due = deliveryDue(f.kind, f.health, d, f.reconDue(d));
    if (due <= f.createdAt) continue;
    const complete = f.kind === "db_watermark" ? (f.completeThrough ? f.completeThrough >= endOfDay(d) : f.untimed) : f.delivered.has(d);
    const r = deliveryOf(f.completedAt.get(d) ?? null, complete, due, now);
    if (r) out[TALLY_KEY[r]]++;
  }
  return out;
}

/** The next occurrence of `cron` after `now`, evaluated in Asia/Jakarta as pg-boss does (kernel/jobs.ts JOB_TZ). */
export const nextRunOf = (cron: string, now: Date): Date => CronExpressionParser.parse(cron, { currentDate: now, tz: DEFAULT_TIMEZONE }).next().toDate();
