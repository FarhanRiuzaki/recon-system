// A parsed row to the core record (spec §7 steps 2–5, §8): every declared field is typed (coerce.ts), derived values
// run in declared order (cel.ts), then the mapping fills business_date, bday_index, the optional core values and attrs.
// Pure: the business-day calendar and the file name come in as arguments. A bad row gets a reason per column, all of
// them, never the first only.
//
// row_hash = SHA-256 (hex) of the raw row as JSON with its keys sorted (so column order never changes it): the
// dedup key of immutable sources (spec §8). natural_key = the key_fields values joined by U+001F (rendered as in attrs;
// null when the source declares no key fields).
import type { FieldSpec, SourceSpec, ValueRef } from "@starterkit/shared/contracts/sources";
import { type Compiled, compileDerive, runDerive } from "./cel";
import { coerce, DEFAULT_SCALE, DEFAULT_TIMEZONE, formatScaled, localDate, type Value } from "./coerce";

export type Calendar = { bdayIndex(date: string): number };
export type CalendarData = { weekend: number[]; holidays: string[] };
export type MapContext = { calendar: Calendar; fileName?: string };
export type CoreRecord = {
  business_date: string;
  bday_index: number;
  amount_minor: bigint | null;
  currency: string | null;
  direction: string | null;
  event_time: string | null;
  ext_ref: string | null;
  account_ref: string | null;
  attrs: Record<string, string | boolean | null>;
  row_hash: string;
  natural_key: string | null;
};
export type MapResult = { ok: true; record: CoreRecord } | { ok: false; reasons: Record<string, string> };

const DAY = 86_400_000;
const dayOf = (iso: string) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / DAY);
const isoWeekday = (day: number) => (((day + 3) % 7) + 7) % 7 + 1; // 1970-01-01 (day 0) was a Thursday

/**
 * bday_index = the number of business days since 1970-01-01 up to and including the date; a weekend day or holiday
 * has the index of the business day before it. Two business days apart = indexes apart by 2.
 */
export function makeCalendar(c: CalendarData): Calendar {
  const off = new Set(c.weekend);
  const holidays = [...new Set(c.holidays.map(dayOf))].filter((d) => d >= 1 && !off.has(isoWeekday(d))).sort((a, b) => a - b);
  const memo = new Map<string, number>();
  return {
    bdayIndex(date) {
      let v = memo.get(date);
      if (v === undefined) {
        const d = dayOf(date);
        let weekend = Math.floor(d / 7) * off.size;
        for (let k = Math.floor(d / 7) * 7 + 1; k <= d; k++) if (off.has(isoWeekday(k))) weekend++;
        v = d - weekend - holidays.filter((h) => h <= d).length;
        if (memo.size > 50_000) memo.clear();
        memo.set(date, v);
      }
      return v;
    },
  };
}

const realIso = (iso: string) => { const t = Date.parse(`${iso}T00:00:00Z`); return !Number.isNaN(t) && new Date(t).toISOString().startsWith(iso); };

/** The date in a file name as yyyymmdd (act20261102.txt → 2026-11-02), or null when there is no real date. */
export function fileDateOf(name: string): string | null {
  for (const m of name.matchAll(/(?<!\d)(\d{4})(\d{2})(\d{2})(?!\d)/g)) {
    const iso = `${m[1]}-${m[2]}-${m[3]}`;
    if (realIso(iso)) return iso;
  }
  return null;
}

type Prepared = { fields: FieldSpec[]; derive: [string, Compiled][]; cel: Map<string, Compiled> };
const prepared = new WeakMap<SourceSpec, Prepared>();

const celExprs = (spec: SourceSpec): [string, string][] => {
  const { attrs, ...core } = spec.mapping;
  const refs: [string, ValueRef | undefined][] = [...Object.entries(core), ...Object.entries(attrs).map(([k, r]): [string, ValueRef] => [`attrs.${k}`, r])];
  return [
    ...Object.entries(spec.derive).map(([k, e]): [string, string] => [`derive.${k}`, e]),
    ...refs.flatMap(([k, r]): [string, string][] => (r && "cel" in r ? [[`mapping.${k}`, r.cel]] : [])),
  ];
};

/** The first CEL expression of a spec that can't be used: "derive.net: <why>", or null. Run when a spec is saved. */
export function specCelError(spec: SourceSpec): string | null {
  for (const [path, expr] of celExprs(spec)) {
    const c = compileDerive(expr);
    if ("error" in c) return `${path}: ${c.error}`;
  }
  return null;
}

function prepare(spec: SourceSpec): Prepared {
  let p = prepared.get(spec);
  if (!p) {
    const must = (e: string) => {
      const c = compileDerive(e);
      if ("error" in c) throw new Error(`Invalid CEL in the spec: ${c.error}`);
      return c;
    };
    p = { fields: spec.fields, derive: Object.entries(spec.derive).map(([k, e]) => [k, must(e)]), cel: new Map(celExprs(spec).map(([, e]) => [e, must(e)])) };
    prepared.set(spec, p);
  }
  return p;
}

/** A value as it is stored in attrs and the natural key: decimals as plain decimal text, integers as text. */
function render(v: Value, f?: FieldSpec): string | boolean | null {
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  return f?.type === "decimal" ? formatScaled(v, f.format?.scale ?? DEFAULT_SCALE) : v.toString();
}
const cleanText = (raw: string, f: FieldSpec) => {
  const t = f.trim ? raw.trim() : raw;
  return f.case === "upper" ? t.toUpperCase() : f.case === "lower" ? t.toLowerCase() : t;
};
const sha256 = (s: string) => new Bun.CryptoHasher("sha256").update(s).digest("hex");
const INT64_MAX = 9223372036854775807n;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function toRecord(raw: Record<string, string>, spec: SourceSpec, ctx: MapContext): MapResult {
  const p = prepare(spec);
  const reasons: Record<string, string> = {};
  const typed: Record<string, Value> = {};
  const byName = new Map<string, FieldSpec>(p.fields.map((f) => [f.name, f]));
  const row: Record<string, string> = {};
  for (const f of p.fields) {
    const text = raw[f.name] ?? "";
    const r = coerce(text, f);
    if (r.ok) { typed[f.name] = r.value; row[f.name] = cleanText(text, f); } else reasons[f.name] = r.reason;
  }
  if (Object.keys(reasons).length) return { ok: false, reasons };

  const fileDate = ctx.fileName ? fileDateOf(ctx.fileName) : null;
  const vars = () => ({ row, file_name: ctx.fileName ?? "", file_date: fileDate ?? "" });
  for (const [name, c] of p.derive) {
    const r = runDerive(c, vars());
    if (!r.ok) { reasons[name] = `${name}: ${r.reason}`; continue; }
    const s = typeof r.value === "string" ? r.value : String(r.value);
    typed[name] = s;
    row[name] = s;
  }
  if (Object.keys(reasons).length) return { ok: false, reasons };

  /** The value a mapping ref points to (a CEL result keeps bigint/boolean/string), or a reason. */
  const resolve = (key: string, ref: ValueRef): { v: Value | number; f?: FieldSpec } | string => {
    if ("field" in ref) return { v: typed[ref.field] ?? null, f: byName.get(ref.field) };
    const r = runDerive(p.cel.get(ref.cel)!, vars());
    if (!r.ok) return `${key}: ${r.reason}`;
    const v = r.value;
    return typeof v === "string" || typeof v === "bigint" || typeof v === "boolean" || typeof v === "number" ? { v } : `${key}: the expression has no value`;
  };
  const fail = (key: string, why: string) => { reasons[key] = `${key}: ${why}`; return null; };
  const str = (key: string, ref?: ValueRef): string | null => {
    if (!ref) return null;
    const r = resolve(key, ref);
    if (typeof r === "string") return fail(key, r.slice(key.length + 2));
    return r.v === null ? null : String(typeof r.v === "number" ? r.v : render(r.v as Value, r.f));
  };

  const m = spec.mapping;
  let business_date = "";
  {
    const r = resolve("business_date", m.business_date);
    if (typeof r === "string") reasons.business_date = r;
    else if (r.f?.type === "datetime" && typeof r.v === "string") {
      try { business_date = localDate(r.v, r.f.format?.timezone ?? DEFAULT_TIMEZONE); } catch { fail("business_date", `unknown time zone "${r.f.format?.timezone}"`); }
    }
    else if (typeof r.v === "string" && ISO_DATE.test(r.v) && realIso(r.v)) business_date = r.v;
    else if (r.v === "" && "cel" in m.business_date && m.business_date.cel.includes("file_date") && !fileDate) fail("business_date", "the file name has no date (yyyymmdd)");
    else fail("business_date", r.v === null || r.v === "" ? "is empty" : `not a date (${JSON.stringify(String(r.v))})`);
  }

  let amount_minor: bigint | null = null;
  if (m.amount_minor) {
    const r = resolve("amount_minor", m.amount_minor);
    if (typeof r === "string") reasons.amount_minor = r;
    else if (typeof r.v === "bigint") amount_minor = r.v; // a decimal field is at scale 2 (checked when the spec is saved)
    else if (typeof r.v === "string" && /^[+-]?\d+$/.test(r.v)) amount_minor = BigInt(r.v);
    else if (r.v !== null) fail("amount_minor", `not whole minor units (${JSON.stringify(String(r.v))})`);
    if (amount_minor !== null && (amount_minor > INT64_MAX || amount_minor < -INT64_MAX - 1n)) { fail("amount_minor", "out of range for a bigint column"); amount_minor = null; }
  }
  let event_time: string | null = null;
  if (m.event_time) {
    const r = resolve("event_time", m.event_time);
    if (typeof r === "string") reasons.event_time = r;
    else if (typeof r.v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(r.v) && !Number.isNaN(Date.parse(r.v))) event_time = new Date(r.v).toISOString();
    else if (r.v !== null) fail("event_time", `not a date-time (${JSON.stringify(String(r.v))})`);
  }
  const currency = str("currency", m.currency), direction = str("direction", m.direction);
  const ext_ref = str("ext_ref", m.ext_ref), account_ref = str("account_ref", m.account_ref);
  const attrs: CoreRecord["attrs"] = {};
  for (const [k, ref] of Object.entries(m.attrs)) {
    const r = resolve(`attrs.${k}`, ref);
    if (typeof r === "string") reasons[`attrs.${k}`] = r;
    else attrs[k] = typeof r.v === "number" ? String(r.v) : render(r.v, r.f);
  }
  if (Object.keys(reasons).length) return { ok: false, reasons };

  const natural_key = spec.key_fields.length ? spec.key_fields.map((k) => String(render(typed[k] ?? null, byName.get(k)) ?? "")).join("\u001f") : null;
  const sorted = Object.fromEntries(Object.entries(raw).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return {
    ok: true,
    record: { business_date, bday_index: ctx.calendar.bdayIndex(business_date), amount_minor, currency, direction, event_time, ext_ref, account_ref, attrs, row_hash: sha256(JSON.stringify(sorted)), natural_key },
  };
}
