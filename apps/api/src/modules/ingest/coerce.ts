// One text cell to its declared type (spec §7 step 2). Money and decimals never touch a JS float: a decimal is read
// from its digits into a scaled bigint ("100.5" and "100.50" at scale 2 are both 10050n). Dates are read by the
// field's pattern (yyyy MM dd HH mm ss) and only real dates pass. A reason names the column, the problem and the value,
// e.g. `amount: not a decimal ("12,3x")` or `sid is required`.
import type { FieldSpec } from "@starterkit/shared/contracts/sources";

/** decimal/integer → bigint (decimal in minor units of `scale`), boolean → boolean, date → "yyyy-mm-dd", datetime → ISO instant in UTC, string → string, empty and nullable → null. */
export type Value = string | bigint | boolean | null;
export type Coerced = { ok: true; value: Value } | { ok: false; reason: string };

export const DEFAULT_TIMEZONE = "Asia/Jakarta";
/** The decimal places a decimal field carries when its format names none (the column's, not the amount's: toMinor). */
export const DEFAULT_SCALE = 2;

const TOKEN = /yyyy|MM|dd|HH|mm|ss/g;
const patterns = new Map<string, { re: RegExp; order: string[] }>();
/** The regex and the token order of a date pattern such as "dd/MM/yyyy". */
function patternOf(p: string) {
  let c = patterns.get(p);
  if (!c) {
    const order: string[] = [];
    const src = p.split(TOKEN).map((lit) => lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    const toks = p.match(TOKEN) ?? [];
    let re = src[0]!;
    toks.forEach((t, i) => { order.push(t); re += `(\\d{${t === "yyyy" ? 4 : 2}})` + src[i + 1]!; });
    c = { re: new RegExp(`^${re}$`), order };
    patterns.set(p, c);
  }
  return c;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const zoned = (tz: string) => {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    formatters.set(tz, f);
  }
  return f;
};
/** Offset of `tz` from UTC at instant `ms`, in ms. */
function offsetMs(ms: number, tz: string): number {
  const p = Object.fromEntries(zoned(tz).formatToParts(new Date(ms)).map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!) - Math.floor(ms / 1000) * 1000;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");
const realDate = (y: number, m: number, d: number) => {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
};

/** The calendar date of ISO instant `iso` in time zone `tz`, as yyyy-mm-dd. */
export function localDate(iso: string, tz: string): string {
  const p = Object.fromEntries(zoned(tz).formatToParts(new Date(iso)).map((x) => [x.type, Number(x.value)]));
  return `${pad(p.year!, 4)}-${pad(p.month!)}-${pad(p.day!)}`;
}

/** A scaled bigint as a plain decimal string: (10050n, 2) → "100.50". */
export function formatScaled(v: bigint, scale: number): string {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(scale + 1, "0");
  return (neg ? "-" : "") + (scale ? `${s.slice(0, -scale)}.${s.slice(-scale)}` : s);
}

const ISO_DATETIME = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * A date or date-time cell by the field's pattern; without one, also the ISO text a database connector writes (a date
 * field takes a date, timestamp or Oracle DATE column, rules.ts FITS: its day as written, or with a zone its day in the
 * field's time zone).
 */
function readDate(s: string, f: FieldSpec): string | null {
  const m = f.format?.date ? null : ISO_DATETIME.exec(s);
  let parts: Record<string, number>;
  let ms = 0;
  let offset: string | undefined;
  if (m) {
    parts = { yyyy: +m[1]!, MM: +m[2]!, dd: +m[3]!, HH: +m[4]!, mm: +m[5]!, ss: +m[6]! };
    ms = m[7] ? +`${m[7]}00`.slice(0, 3) : 0; // milliseconds from the digits
    offset = m[8];
  } else {
    const { re, order } = patternOf(f.format?.date ?? (f.type === "date" ? "yyyy-MM-dd" : "yyyy-MM-dd HH:mm:ss"));
    const r = re.exec(s);
    if (!r) return null;
    parts = { HH: 0, mm: 0, ss: 0 };
    order.forEach((t, i) => (parts[t] = +r[i + 1]!));
    if (parts.yyyy === undefined || parts.MM === undefined || parts.dd === undefined) return null;
  }
  const { yyyy: y, MM: mo, dd: d, HH: h, mm: mi, ss: sec } = parts as Record<string, number>;
  if (!realDate(y!, mo!, d!) || h! > 23 || mi! > 59 || sec! > 59) return null;
  if (f.type === "date" && !offset) return `${pad(y!, 4)}-${pad(mo!)}-${pad(d!)}`;
  const wall = Date.UTC(y!, mo! - 1, d!, h, mi, sec);
  let utc: number;
  if (offset) {
    utc = offset === "Z" ? wall : wall - (offset[0] === "-" ? -1 : 1) * (+offset.slice(1, 3) * 60 + +offset.slice(-2)) * 60_000;
  } else {
    const tz = f.format?.timezone ?? DEFAULT_TIMEZONE;
    utc = wall - offsetMs(wall - offsetMs(wall, tz), tz); // twice, so a cell near a DST change lands right
  }
  const iso = new Date(utc + ms).toISOString();
  return f.type === "date" ? localDate(iso, f.format?.timezone ?? DEFAULT_TIMEZONE) : iso;
}

/** `int` (no sign) with its thousand separators checked and removed: plain digits, or groups of three after 1–3 leading digits. */
function ungroup(int: string, tsep?: string): string | null {
  if (!tsep || !int.includes(tsep)) return /^\d*$/.test(int) ? int : null;
  const parts = int.split(tsep);
  return /^\d{1,3}$/.test(parts[0]!) && parts.slice(1).every((p) => /^\d{3}$/.test(p)) ? parts.join("") : null;
}

/** Digits of a decimal text as a scaled bigint, or why not (a reason without the column). */
function readDecimal(s: string, f: FieldSpec): { v: bigint } | { why: string } {
  const scale = f.format?.scale ?? DEFAULT_SCALE;
  const dsep = f.format?.decimalSeparator ?? ".";
  const tsep = f.format?.thousandSeparator === dsep ? undefined : f.format?.thousandSeparator;
  const neg = s.startsWith("-");
  const body = /^[+-]/.test(s) ? s.slice(1) : s;
  const parts = body.split(dsep);
  const int = parts.length <= 2 ? ungroup(parts[0]!, tsep) : null;
  const frac = parts[1] ?? "";
  if (int === null || !/^\d*$/.test(frac) || (parts.length === 2 && !frac) || (!int && !frac)) return { why: "not a decimal" };
  if (frac.length > scale && /[1-9]/.test(frac.slice(scale))) return { why: `more than ${scale} decimal places` };
  const n = BigInt((int || "0") + frac.slice(0, scale).padEnd(scale, "0"));
  return { v: neg ? -n : n };
}

const BOOLS: Record<string, boolean> = { true: true, false: false, "1": true, "0": false, y: true, n: false, yes: true, no: false, t: true, f: false };

export function coerce(value: string, field: FieldSpec): Coerced {
  const isText = field.type === "string";
  const s = isText && !field.trim ? value : value.trim();
  if (s.trim() === "") return field.nullable ? { ok: true, value: null } : { ok: false, reason: `${field.name} is required` };
  const no = (what: string): Coerced => ({ ok: false, reason: `${field.name}: ${what} (${JSON.stringify(value)})` });
  switch (field.type) {
    case "string": return { ok: true, value: field.case === "upper" ? s.toUpperCase() : field.case === "lower" ? s.toLowerCase() : s };
    case "integer": {
      const g = ungroup(/^[+-]/.test(s) ? s.slice(1) : s, field.format?.thousandSeparator);
      return g ? { ok: true, value: BigInt(s.startsWith("-") ? `-${g}` : g) } : no("not an integer");
    }
    case "decimal": {
      const r = readDecimal(s, field);
      return "v" in r ? { ok: true, value: r.v } : no(r.why);
    }
    case "boolean": {
      const b = BOOLS[s.toLowerCase()];
      return b === undefined ? no("not a boolean") : { ok: true, value: b };
    }
    case "date":
    case "datetime": {
      let d: string | null;
      try { d = readDate(s, field); } catch { return { ok: false, reason: `${field.name}: unknown time zone "${field.format?.timezone}"` }; }
      return d === null ? no(field.type === "date" ? "not a date" : "not a date-time") : { ok: true, value: d };
    }
  }
}
