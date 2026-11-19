// What the source wizard and the version page compute from a spec, without React: the columns of a text sample, the
// field type a database column starts as, the field an API error names, and a version's changes against another.
// The API checks every spec again (refines, CEL, kind, calendar); this only shapes what the user edits and reads.
import type { FieldSpec, SourceColumnsDto, SourceSpec, ValueRef } from "@starterkit/shared/contracts/sources";
import type { DbEngine, FIELD_TYPES } from "@starterkit/shared/sources";
import { APP_TIME_ZONE_LABEL } from "@starterkit/ui/lib/format";

export type FieldType = (typeof FIELD_TYPES)[number];
export const TYPE_LABEL: Record<FieldType, string> = {
  string: "Text", integer: "Whole number", decimal: "Decimal", date: "Date", datetime: "Date and time", boolean: "Yes or no",
};
/** The expression a business date taken from the file name is (CEL variable `file_date`). */
export const FILE_DATE = { cel: "file_date" } satisfies ValueRef;

const colName = (i: number, n: number) => `col_${String(i + 1).padStart(Math.max(2, String(n).length), "0")}`;

/** The cells of one line split on `delimiter`, a `quote` character (null = none) keeping delimiters inside it. */
function cells(line: string, delimiter: string, quote: string | null): string[] {
  const out: string[] = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote && ch === quote) {
      if (quoted && line[i + 1] === quote) { cur += ch; i++; } else quoted = !quoted;
    } else if (ch === delimiter && !quoted) { out.push(cur); cur = ""; } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * The column names of a text sample: its header's names (trimmed; an empty or repeated one becomes col_NN) or, without a
 * header, col_01 … col_N from the first line. An empty sample has none.
 */
export function sampleColumns(sample: string, delimiter: string, quote: string | null, header: boolean): string[] {
  const first = sample.replace(/^﻿/, "").split(/\r?\n/).find((l) => l.trim() !== "");
  if (first === undefined) return [];
  const row = cells(first, delimiter, quote);
  if (!header) return row.map((_, i) => colName(i, row.length));
  const seen = new Set<string>();
  return row.map((c, i) => {
    const name = c.trim();
    const pick = name && !seen.has(name) ? name : colName(i, row.length);
    seen.add(pick);
    return pick;
  });
}

/** At most `max` bytes of a sample, cut at a line end (the preview's body holds the spec too, under the 64 KB limit). */
export function sampleHead(sample: string, max = 32 * 1024): { text: string; cut: boolean } {
  const bytes = new TextEncoder().encode(sample);
  if (bytes.length <= max) return { text: sample, cut: false };
  const head = new TextDecoder().decode(bytes.slice(0, max));
  const end = head.lastIndexOf("\n");
  return { text: end > 0 ? head.slice(0, end + 1) : head, cut: true };
}

/**
 * The field type a database column starts as (the user corrects it): whole numbers, decimals with their scale, dates,
 * timestamps and booleans; anything else text. `note` = why the user may want to change it: SQL Server sends float and
 * real in scientific notation, so they start as text.
 */
export function fieldTypeOf(engine: DbEngine, native: string): { type: FieldType; scale?: number; note?: string } {
  const t = native.toLowerCase().trim();
  const num = /^(?:numeric|decimal|number)\s*\(\s*(\d+)\s*(?:,\s*(-?\d+)\s*)?\)/.exec(t);
  if (num) {
    const scale = Number(num[2] ?? 0);
    return scale > 0 ? { type: "decimal", scale: Math.min(scale, 18) } : { type: "integer" };
  }
  if (/^(?:big|small|tiny|medium)?int(?:eger)?\b|^int[248]\b|^(?:big|small)?serial\b/.test(t)) return { type: "integer" };
  if (/^(?:small)?money\b/.test(t)) return { type: "decimal", scale: 4 };
  if (/^(?:float|real|double|binary_float|binary_double)\b/.test(t)) {
    return engine === "mssql" ? { type: "string", note: "SQL Server sends float and real in scientific notation (1.5E+2). Keep it as text, or cast it to decimal in a custom SELECT." } : { type: "string" };
  }
  if (/^date$/.test(t)) return { type: "date" };
  if (/^(?:timestamp|datetime|datetime2|datetimeoffset|smalldatetime)\b/.test(t)) return { type: "datetime" };
  if (/^(?:bool|boolean|bit)$/.test(t)) return { type: "boolean" };
  return { type: "string" };
}

/** A database table's columns as the fields they start as: the detected type, empty allowed when the column allows NULL. */
export function fieldsOfColumns(engine: DbEngine, columns: SourceColumnsDto["columns"]): FieldSpec[] {
  return columns.map((c) => {
    const t = fieldTypeOf(engine, c.type);
    return { name: c.name, type: t.type, nullable: c.nullable ?? true, trim: t.type === "string", ...(t.scale !== undefined ? { format: { scale: t.scale } } : {}) };
  });
}

/**
 * `next` fields merged into `kept`: a field of the same name keeps the user's settings, a new one comes in as detected,
 * one that is gone is dropped (a pull of a column the source lacks fails). Order follows `next`.
 */
export function mergeFields(kept: readonly FieldSpec[], next: readonly FieldSpec[]): FieldSpec[] {
  const by = new Map(kept.map((f) => [f.name, f]));
  return next.map((f) => by.get(f.name) ?? f);
}

/**
 * The field an API error names ("Check mapping.amount_minor: …", "Check the expression at derive.net: …"), as its
 * path and the reason after it; null for an error that names no field.
 */
export function fieldError(message: string): { path: string; reason: string } | null {
  const m = /^Check (?:the expression at )?((?:fields|mapping|derive|key_fields|input|health|mutable|calendar)(?:\.[^:\s]+)*): ([\s\S]+)$/.exec(message);
  return m ? { path: m[1]!, reason: m[2]! } : null;
}

const refText = (r: ValueRef | undefined): string | null => (!r ? null : "field" in r ? r.field : r.cel === FILE_DATE.cel ? "the file name's date" : `expression ${r.cel}`);
/** A field as the diff reads it: "Decimal, 2 places, never empty". */
export function fieldText(f: FieldSpec): string {
  const fmt = f.format;
  return [
    TYPE_LABEL[f.type],
    f.type === "decimal" ? `${fmt?.scale ?? 2} places` : null,
    fmt?.date ? `format ${fmt.date}` : null,
    fmt?.timezone ? fmt.timezone : null,
    fmt?.decimalSeparator && fmt.decimalSeparator !== "." ? `decimal separator ${fmt.decimalSeparator}` : null,
    fmt?.thousandSeparator ? `thousands separator ${fmt.thousandSeparator === " " ? "space" : fmt.thousandSeparator}` : null,
    f.nullable ? null : "never empty",
  ].filter(Boolean).join(", ");
}

export type DiffRow = { key: string; label: string; before: string | null; after: string | null };
const CORE = ["business_date", "amount_minor", "currency", "direction", "event_time", "ext_ref", "account_ref"] as const;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What `after` changes against `before` (the published version; null = none yet), one row per field, mapping, derived
 * value or setting that differs; `before`/`after` null = not there. Unchanged parts make no row.
 */
export function specDiff(before: SourceSpec | null, after: SourceSpec): DiffRow[] {
  const rows: DiffRow[] = [];
  const push = (key: string, label: string, b: string | null, a: string | null) => { if (b !== a) rows.push({ key, label, before: b, after: a }); };
  const bf = new Map((before?.fields ?? []).map((f) => [f.name, f]));
  const af = new Map(after.fields.map((f) => [f.name, f]));
  for (const name of new Set([...af.keys(), ...bf.keys()])) {
    const b = bf.get(name), a = af.get(name);
    push(`field:${name}`, name, b ? fieldText(b) : null, a ? fieldText(a) : null);
  }
  for (const k of CORE) push(`mapping:${k}`, k, refText(before?.mapping[k]), refText(after.mapping[k]));
  const ba = before?.mapping.attrs ?? {}, aa = after.mapping.attrs;
  for (const k of new Set([...Object.keys(aa), ...Object.keys(ba)])) push(`attrs:${k}`, `attrs.${k}`, refText(ba[k]), refText(aa[k]));
  const bd = before?.derive ?? {}, ad = after.derive;
  for (const k of new Set([...Object.keys(ad), ...Object.keys(bd)])) push(`derive:${k}`, k, bd[k] ?? null, ad[k] ?? null);
  push("key_fields", "Match key", before ? before.key_fields.join(", ") || "none" : null, after.key_fields.join(", ") || "none");
  push("mutable", "Rows change after arrival", before ? (before.mutable ? "yes" : "no") : null, after.mutable ? "yes" : "no");
  push("calendar", "Calendar", before?.calendar ?? null, after.calendar);
  if (!before || !same(before.input, after.input)) {
    const keys = new Set([...Object.keys(after.input), ...Object.keys(before?.input ?? {})].filter((k) => k !== "kind"));
    for (const k of keys) {
      const b = before ? (before.input as Record<string, unknown>)[k] : undefined, a = (after.input as Record<string, unknown>)[k];
      if (!same(b, a)) push(`input:${k}`, INPUT_LABEL[k] ?? k, b === undefined ? null : inputText(b), a === undefined ? null : inputText(a));
    }
  }
  if (!same(before?.health ?? null, after.health ?? null)) push("health", "Health", healthText(before?.health), healthText(after.health));
  return rows;
}
const INPUT_LABEL: Record<string, string> = {
  path: "Folder", pattern: "File name pattern", completion: "File is complete when", format: "File format", table: "Table", query: "Query",
  watermark: "Watermark", lookback_seconds: "Look back", chunk: "Rows per page", schedule: "Schedule",
};
function inputText(v: unknown): string {
  if (typeof v !== "object" || v === null) return String(v);
  const o = v as Record<string, unknown>;
  if (o.kind === "stable_seconds") return `Size unchanged for ${String(o.seconds)} s`;
  if (o.kind === "marker_file") return "A .done file with the same name arrives";
  if (o.kind === "delimited") return `Delimited by ${o.delimiter === "\t" ? "tab" : String(o.delimiter)}, ${o.header ? "first row is a header" : "no header"}, ${String(o.encoding)}`;
  if ("column" in o) return `${String(o.column)}, then ${String(o.id_column)}`;
  return JSON.stringify(v);
}
const healthText = (h: SourceSpec["health"]) => (!h ? null : [h.graceMinutes ? `grace ${h.graceMinutes} min` : null, h.deadline ? `deadline ${h.deadline} ${APP_TIME_ZONE_LABEL}` : null].filter(Boolean).join(", ") || null);

/**
 * Why `me` can't approve (or reject) version `v` here, or null (designer's final copy, 20 Nov 2026): not waiting any
 * more, submitted it, worked on it without submitting, or holds no config checker role in the space. The API answers
 * the same cases 409 self_approval / invalid_state and 403; this only says why before the press.
 */
export function reviewReason(v: { status: string; submitterId: string | null; makerId: string | null; contributorIds: string[] }, me: string, checker: boolean, act: "approve" | "reject"): string | null {
  if (v.status !== "in_review") return `This version is no longer waiting for approval.`;
  if (v.submitterId === me) return `You submitted this version. Another config checker ${act}s it.`;
  if (v.makerId === me || v.contributorIds.includes(me)) return `You worked on this version. A config checker who didn't work on it ${act}s it.`;
  if (!checker) return `Only a config checker of this space ${act}s source versions.`;
  return null;
}
