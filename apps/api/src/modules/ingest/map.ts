// A parsed row to the core record (spec §7 steps 2–5, §8): every declared field is typed (coerce.ts), derived values
// run in declared order (cel.ts), then the mapping fills business_date, bday_index, the optional core values and attrs.
// Pure: the business-day calendar and the file name come in as arguments. A bad row gets a reason per column, all of
// them, never the first only.
//
// row_hash = SHA-256 (hex) of the raw row as JSON with its keys sorted (so column order never changes it): the
// dedup key of immutable sources (spec §8). natural_key = the key_fields values joined by U+001F (rendered as in attrs;
// null when the source declares no key fields); a row with an empty or NULL key field is quarantined, so two such rows
// never share a key. A database row's SQL NULL arrives as null, never "" (connectors/): typed it is null like an empty
// cell, but the hash keeps null, so the hash never mistakes NULL for "".
//
// Amount and currency (spec §8): the currency (" idr ", "360" → IDR; unknown → quarantined) comes from its column or the
// spec's fixed `currency`; the amount is read in its unit (amountUnit: declared, else as before the unit existed) and
// scaled per row by that currency's ISO 4217 exponent. A spec saved before both existed and mapping no currency keeps
// the old reading: a decimal field's own scale is its minor unit.
//
// The amount's sign has one source (Plan 3): with direction mapped, the direction ("debit"/"credit", read from the
// codes in directionOf; an empty or unknown one next to an amount is quarantined) and the amount is stored unsigned.
// Direction from a column: a negative amount is quarantined. Direction from CEL (spec §7: often from the amount's own
// sign): the amount's magnitude is stored, and a negative amount on a credit is quarantined. Without direction, the
// amount keeps its own sign. signedAmount gives the signed value the engine uses.
import type { FieldSpec, SourceSpec, ValueRef } from "@starterkit/shared/contracts/sources";
import { amountUnit, CURRENCY_EXPONENT, currencyCode, DIRECTION_HINT, directionOf, toMinor } from "@starterkit/shared/sources";
import { type Compiled, compileDerive, runDerive } from "./cel";
import { coerce, DEFAULT_SCALE, DEFAULT_TIMEZONE, formatScaled, localDate, type Value } from "./coerce";

export type Calendar = { bdayIndex(date: string): number };
export type CalendarData = { weekend: number[]; holidays: string[] };
/**
 * `arrivedDate`: the business date of the pull, file or snapshot the row came in (CEL `arrived_date`), for a source
 * whose rows carry no date (owner, 21 Nov); a snapshot's own date, else today in Asia/Jakarta when left out.
 */
export type MapContext = { calendar: Calendar; fileName?: string; arrivedDate?: string };
export type CoreRecord = {
  business_date: string;
  bday_index: number;
  amount_minor: bigint | null;
  /** The amount as read, before its unit and currency scaled it, as plain decimal text ("25517.79"); for the preview. */
  amount_text: string | null;
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

export function toRecord(raw: Record<string, string | null>, spec: SourceSpec, ctx: MapContext): MapResult {
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
  // ponytail: a pull or file is dated the day it is mapped, so a row mapped after midnight lands on the next day; a
  // source that needs the day before uses a snapshot (dated by its run) or a date column
  const arrived = ctx.arrivedDate ?? localDate(new Date().toISOString(), DEFAULT_TIMEZONE);
  const vars = () => ({ row, file_name: ctx.fileName ?? "", file_date: fileDate ?? "", arrived_date: arrived });
  for (const [name, c] of p.derive) {
    const r = runDerive(c, vars());
    if (!r.ok) { reasons[name] = `${name}: ${r.reason}`; continue; }
    const s = typeof r.value === "string" ? r.value : String(r.value);
    typed[name] = s;
    row[name] = s;
  }
  for (const k of spec.key_fields) if (typed[k] === null || typed[k] === "" || typed[k] === undefined) reasons[k] = `${k} is required (a key field)`;
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

  let currency: string | null = spec.currency ?? null;
  const ccyKey = m.currency && "field" in m.currency ? m.currency.field : "currency";
  if (m.currency) {
    const c = str("currency", m.currency);
    currency = c === null ? null : currencyCode(c);
    if (c !== null && !currency) reasons[ccyKey] = `${ccyKey}: ${JSON.stringify(c)} is not a currency code`;
  }
  let amount_minor: bigint | null = null, amount_text: string | null = null;
  if (m.amount_minor) {
    const ref = m.amount_minor;
    const key = "field" in ref ? ref.field : "amount_minor";
    const r = resolve("amount_minor", ref);
    const no = (why: string, v: unknown) => { reasons[key] = `${key}: ${why} (${JSON.stringify("field" in ref ? raw[key] ?? "" : String(v))})`; };
    // the amount as a bigint at `scale` places: a decimal field's value, an integer, or a CEL int or decimal text
    let n: bigint | null = null, scale = 0;
    if (typeof r === "string") reasons[key] = r;
    else if (typeof r.v === "bigint") { n = r.v; scale = r.f?.type === "decimal" ? r.f.format?.scale ?? DEFAULT_SCALE : 0; }
    else if (typeof r.v === "string" && /^[+-]?\d+(\.\d+)?$/.test(r.v)) { const [i, f = ""] = r.v.split("."); n = BigInt(i! + f); scale = f.length; }
    else if (r.v !== null) no("not a number", r.v);
    if (n !== null) amount_text = formatScaled(n, scale);
    if (n !== null && !reasons[ccyKey]) {
      const unit = amountUnit(spec)!;
      // a spec saved before currencies existed maps none: the field's own scale is its minor unit, as it was then
      const legacy = !m.currency && spec.currency === undefined;
      if (unit === "major" && !currency && !legacy) no("no currency on this row to scale it by", n);
      else {
        const x = toMinor(n, scale, unit, currency ? CURRENCY_EXPONENT[currency]! : scale, currency ?? "");
        if ("why" in x) no(x.why, typeof r === "string" ? n : r.v);
        else if (x.v > INT64_MAX || x.v < -INT64_MAX - 1n) no("out of range for a bigint column", n);
        else amount_minor = x.v;
      }
    }
  }
  let event_time: string | null = null;
  if (m.event_time) {
    const r = resolve("event_time", m.event_time);
    if (typeof r === "string") reasons.event_time = r;
    else if (typeof r.v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(r.v) && !Number.isNaN(Date.parse(r.v))) event_time = new Date(r.v).toISOString();
    else if (r.v !== null) fail("event_time", `not a date-time (${JSON.stringify(String(r.v))})`);
  }
  let direction = str("direction", m.direction);
  const dirKey = m.direction && "field" in m.direction ? m.direction.field : "direction";
  if (m.direction && !reasons[dirKey] && !reasons.direction) {
    const d = direction === null ? null : directionOf(direction);
    if (direction !== null && !d) reasons[dirKey] = `${dirKey}: ${JSON.stringify(direction)} is not a debit or a credit (${DIRECTION_HINT})`;
    else if (d === null && amount_minor !== null) reasons[dirKey] = `${dirKey}: is empty; the amount's sign comes from it`;
    direction = d;
  }
  if (m.direction && amount_minor !== null && amount_minor < 0n) {
    const key = "field" in m.amount_minor! ? m.amount_minor.field : "amount_minor";
    const read = JSON.stringify("field" in m.amount_minor! ? raw[key] ?? "" : String(amount_minor));
    // a direction read from a column carries the sign, so the amount must be unsigned; one a CEL expression computes
    // (often from the amount's own sign) leaves the amount's magnitude, unless the sign says the opposite of it
    if ("field" in m.direction) reasons[key] = `${key}: negative, but direction is mapped; the sign comes from direction (${read})`;
    else if (direction === "credit") reasons[key] = `${key}: negative, but the row is a credit (${read})`;
    else amount_minor = -amount_minor;
  }
  const ext_ref = str("ext_ref", m.ext_ref), account_ref = str("account_ref", m.account_ref);
  const attrs: CoreRecord["attrs"] = {};
  for (const [k, ref] of Object.entries(m.attrs)) {
    const r = resolve(`attrs.${k}`, ref);
    if (typeof r === "string") reasons[`attrs.${k}`] = r;
    else attrs[k] = typeof r.v === "number" ? String(r.v) : render(r.v, r.f);
  }
  if (Object.keys(reasons).length) return { ok: false, reasons };

  const natural_key = spec.key_fields.length
    ? spec.key_fields.map((k) => String(render(typed[k]!, byName.get(k)))).join("\u001f") : null;
  const sorted = Object.fromEntries(Object.entries(raw).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return {
    ok: true,
    record: { business_date, bday_index: ctx.calendar.bdayIndex(business_date), amount_minor, amount_text, currency, direction, event_time, ext_ref, account_ref, attrs, row_hash: sha256(JSON.stringify(sorted)), natural_key },
  };
}

/**
 * The amount with its sign (Plan 3: the engine's one rule): negated for a debit, else as stored; null without an
 * amount. The direction is read through directionOf, so a raw code stored before directions were normalised counts too.
 */
export const signedAmount = (r: { amount_minor: bigint | null; direction: string | null }): bigint | null =>
  r.amount_minor === null ? null : r.direction !== null && directionOf(r.direction) === "debit" ? -r.amount_minor : r.amount_minor;
