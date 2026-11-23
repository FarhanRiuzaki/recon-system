// Mapping a recon's data onto a bank operation's request (design 2026-11-22-recon-approval-and-posting §4.5), zod-free
// and pure: the sources a request field takes, the changes (transforms) applied to a value, and the references a
// template makes, so the contract and the editor check the same way.

import { type Condition, type Context, evaluate, isMoneyKey } from "./conditions";
import { formatNow, type OpField } from "./integrations";
import { CURRENCY_EXPONENT } from "./sources";

export type Transform = string;
export type Source =
  | { kind: "field"; key: string; transforms: Transform[] }
  | { kind: "const"; value: string }
  | { kind: "template"; text: string }
  | { kind: "lookup"; table: string; key: Source; fallback?: string }
  | { kind: "account"; account: string; part: "number" | "label" | "currency" };

/** The changes a value may go through, in order, as people read them. */
export const TRANSFORMS: readonly { pattern: RegExp; label: string }[] = [
  { pattern: /^date:[yMdHms\-/.: T]{2,30}$/, label: "date as a pattern (yyyy yy MM dd HH mm ss)" },
  { pattern: /^amount:minor$/, label: "amount in minor units (whole number, by the currency)" },
  { pattern: /^amount:major:[0-4]$/, label: "amount with N decimals" },
  { pattern: /^pad_left:\d{1,3}:.$/, label: "pad on the left to N with a character" },
  { pattern: /^pad_right:\d{1,3}:.$/, label: "pad on the right to N with a character" },
  { pattern: /^(trim|upper|lower|abs)$/, label: "trim, upper case, lower case, or without sign" },
  { pattern: /^truncate_left:\d{1,3}$/, label: "keep the last N characters" },
  { pattern: /^truncate_right:\d{1,3}$/, label: "keep the first N characters" },
  { pattern: /^default:.{0,100}$/, label: "a value when empty" },
];
export const isTransform = (t: string) => TRANSFORMS.some((x) => x.pattern.test(t));

/** `{…}` parts of a template: a field with changes (`{break.amount|amount:minor}`) or an account (`{accounts.key.part}`). */
export function templateParts(text: string): { field?: { key: string; transforms: string[] }; account?: { key: string; part: string } }[] {
  return [...text.matchAll(/\{([^{}]+)\}/g)].map((m) => {
    const [ref, ...transforms] = m[1]!.split("|").map((s) => s.trim());
    const acc = /^accounts\.([a-z0-9_]+)\.(number|label|currency)$/.exec(ref!);
    return acc ? { account: { key: acc[1]!, part: acc[2]! } } : { field: { key: ref!, transforms } };
  });
}

export const ACTIONS_MAX = 10, VARIANTS_MAX = 20, MAPPED_MAX = 300, ACCOUNTS_MAX = 50, LOOKUPS_MAX = 20, LOOKUP_ROWS_MAX = 500;


// ---- the engine: a payload from a break's context (stage 4) ----
type Setup = { accounts: readonly { key: string; label: string; number: string; currency: string }[]; lookups: readonly { name: string; rows: readonly { key: string; value: string }[] }[] };
type VariantLike = { name: string; when: Condition | null; mapping: Readonly<Record<string, Source>>; zeroOrNegative: "skip" | "absolute_swap" };
export type Built = { ok: true; payload: Record<string, unknown>; sources: Record<string, string> } | { ok: false; code: "build_error" | "lookup" | "skipped"; field: string; message: string };

const exponent = (ccy?: string) => (ccy && CURRENCY_EXPONENT[ccy.toUpperCase()] !== undefined ? CURRENCY_EXPONENT[ccy.toUpperCase()]! : 2);
/** Thrown by an amount change on a value that isn't whole minor units: buildPayload refuses it, naming the field. */
export class NotWholeAmount extends Error { constructor(readonly value: string) { super(); } }
/** `v` as whole minor units ("-150"); "" stays "" (a required check names it); anything else (2500.50, 1,000) refuses. */
function wholeMinor(v: string): string {
  const t = v.trim();
  if (t === "" || /^-?\d+$/.test(t)) return t;
  throw new NotWholeAmount(v);
}
/** A whole number of minor units as major units with `n` decimals (half up), exact (BigInt). */
function major(minor: string, exp: number, n: number): string {
  const m = wholeMinor(minor);
  if (!m) return m;
  let v = BigInt(m);
  const neg = v < 0n; if (neg) v = -v;
  if (n >= exp) v *= 10n ** BigInt(n - exp);
  else { const d = 10n ** BigInt(exp - n); v = (v + d / 2n) / d; }
  const t = v.toString().padStart(n + 1, "0");
  return `${neg ? "-" : ""}${n ? `${t.slice(0, -n)}.${t.slice(-n)}` : t}`;
}
/** `value` through `ts`, in order; amounts are minor units (as the context holds them), dates read in Asia/Jakarta. */
export function applyTransforms(value: string, ts: readonly Transform[], at: { currency?: string }): string {
  let v = value;
  for (const t of ts) {
    let m: RegExpExecArray | null;
    if ((m = /^date:(.+)$/.exec(t))) {
      if (!v) continue;
      const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T00:00:00+07:00`) : new Date(v);
      if (!Number.isNaN(d.getTime())) v = formatNow(m[1]!, d);
    } else if (t === "amount:minor") v = wholeMinor(v);
    else if ((m = /^amount:major:(\d)$/.exec(t))) v = major(v, exponent(at.currency), Number(m[1]));
    else if ((m = /^pad_left:(\d+):(.)$/.exec(t))) v = v.padStart(Number(m[1]), m[2]);
    else if ((m = /^pad_right:(\d+):(.)$/.exec(t))) v = v.padEnd(Number(m[1]), m[2]);
    else if (t === "trim") v = v.trim();
    else if (t === "upper") v = v.toUpperCase();
    else if (t === "lower") v = v.toLowerCase();
    else if (t === "abs") v = v.replace(/^\s*-/, "");
    else if ((m = /^truncate_left:(\d+)$/.exec(t))) v = v.slice(Math.max(0, v.length - Number(m[1])));
    else if ((m = /^truncate_right:(\d+)$/.exec(t))) v = v.slice(0, Number(m[1]));
    else if ((m = /^default:(.*)$/.exec(t))) v = v.trim() ? v : m[1]!;
  }
  return v;
}

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
/** A template's text with each `{field|changes}` and `{accounts.key.part}` filled. */
export function renderTemplate(text: string, ctx: Context, setup: Setup): string {
  return text.replace(/\{([^{}]+)\}/g, (_, inner: string) => {
    const [ref, ...ts] = inner.split("|").map((x) => x.trim());
    const acc = /^accounts\.([a-z0-9_]+)\.(number|label|currency)$/.exec(ref!);
    if (acc) return str(setup.accounts.find((a) => a.key === acc[1])?.[acc[2] as "number"]);
    return applyTransforms(str(ctx[ref!]), ts, { currency: str(ctx["break.currency"]) });
  });
}

class Miss extends Error { constructor(readonly table: string, readonly key: string) { super(); } }
function resolve(src: Source, ctx: Context, setup: Setup): string {
  switch (src.kind) {
    case "field": return applyTransforms(str(ctx[src.key]), src.transforms, { currency: str(ctx["break.currency"]) });
    case "const": return src.value;
    case "template": return renderTemplate(src.text, ctx, setup);
    case "account": return str(setup.accounts.find((a) => a.key === src.account)?.[src.part]);
    case "lookup": {
      const k = resolve(src.key, ctx, setup);
      const row = setup.lookups.find((l) => l.name === src.table)?.rows.find((r) => r.key === k);
      if (row) return row.value;
      if (src.fallback !== undefined) return src.fallback;
      throw new Miss(src.table, k);
    }
  }
}
const sourceName = (src: Source) => (src.kind === "field" ? src.key : src.kind === "const" ? "fixed" : src.kind === "template" ? "template" : src.kind === "lookup" ? `lookup ${src.table}` : `account ${src.account}`);
function fieldAt(fields: readonly OpField[], path: string): OpField | undefined {
  let at: readonly OpField[] | undefined = fields, f: OpField | undefined;
  for (const p of path.split(".")) { f = at?.find((x) => x.name === p); at = f?.children; }
  return f;
}
function valueAt(o: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), o);
}
function setAt(o: Record<string, unknown>, path: string, v: unknown) {
  const parts = path.split(".");
  let at = o;
  for (const p of parts.slice(0, -1)) {
    if (p === "__proto__" || p === "constructor" || p === "prototype") return;
    const next = at[p];
    at = (next && typeof next === "object" && !Array.isArray(next) ? next : (at[p] = {})) as Record<string, unknown>;
  }
  const last = parts.at(-1)!;
  if (last !== "__proto__" && last !== "constructor" && last !== "prototype") at[last] = v;
}

/** `v` (digits, maybe a sign and decimals) survives as a JSON number: a whole number up to 2^53 - 1, a decimal of 15 digits at most. */
function exactNumber(v: string): boolean {
  if (Math.abs(Number(v)) > Number.MAX_SAFE_INTEGER) return false;
  return !v.includes(".") || v.replace(/^-/, "").replace(".", "").replace(/^0+/, "").length <= 15;
}
/**
 * The request payload a variant builds for a break's context: each mapped field from its source (numbers as numbers for
 * numeric fields), refused — naming the field — when a value is longer than the bank takes, a lookup misses, or a
 * required field ends up empty (fields in `handled` are filled by the operation itself: fixed or auto). An amount of 0
 * is skipped when the variant says so.
 * A numeric field whose value a JSON number can't hold exactly (beyond 2^53, or more than 15 digits with decimals) is
 * refused rather than rounded: map such a field as text (type string) when a bank needs one.
 */
export function buildPayload(v: VariantLike, op: { request: readonly OpField[] }, ctx: Context, setup: Setup, handled: ReadonlySet<string>): Built {
  const amount = str(ctx["break.amount"]);
  if (v.zeroOrNegative === "skip" && /^-?\d+$/.test(amount) && BigInt(amount) <= 0n) return { ok: false, code: "skipped", field: "", message: "The amount is 0 or below: nothing to post." };
  const payload: Record<string, unknown> = {}, sources: Record<string, string> = {};
  for (const [path, src] of Object.entries(v.mapping)) {
    let value: string;
    try { value = resolve(src, ctx, setup); } catch (e) {
      if (e instanceof Miss) return { ok: false, code: "lookup", field: path, message: `Lookup ${e.table} has no ${e.key || "value"}.` };
      if (e instanceof NotWholeAmount) return { ok: false, code: "build_error", field: path, message: `${path}: “${e.value}” isn't a whole amount in minor units, so an amount change can't read it.` };
      throw e;
    }
    const f = fieldAt(op.request, path);
    if (f?.maxLength && value.length > f.maxLength) {
      return { ok: false, code: "build_error", field: path, message: `${path} is ${value.length} characters; the bank takes ${f.maxLength}. Add a change that keeps the first or the last ${f.maxLength}.` };
    }
    if (f?.type === "numeric" && /^-?\d+(\.\d+)?$/.test(value)) {
      if (!exactNumber(value)) return { ok: false, code: "build_error", field: path, message: `${path}: ${value} is too large an amount to send as a number without losing digits.` };
      setAt(payload, path, Number(value));
    } else setAt(payload, path, value);
    sources[path] = sourceName(src);
  }
  const missing = (fs: readonly OpField[], prefix: string): string | null => {
    for (const f of fs) {
      const path = `${prefix}${f.name}`;
      if (f.children?.length) { const m = missing(f.children, `${path}.`); if (m) return m; continue; }
      if (f.required && !handled.has(path) && str(valueAt(payload, path)).trim() === "") return path;
    }
    return null;
  };
  const gap = missing(op.request, "");
  if (gap) return { ok: false, code: "build_error", field: gap, message: `${gap} is required, and this item has no value for it.` };
  return { ok: true, payload, sources };
}

// ---- grouped variants (stage 5, design §4.4 dispatch group, §4.6.5, O7/O10) ----
/** ponytail: one group sends at most 500 breaks; the next one opens part 2 of the same period. A setting when a bank needs less. */
export const GROUP_MAX = 500, GROUP_KEY_MAX = 5;
const DAY_MS = 86_400_000, WIB_MS = 7 * 3_600_000;
/** The period an approval at `at` belongs to: its date in Asia/Jakarta (UTC+7 all year), the next day at or after `cutoff` (HH:MM). */
export function periodOf(at: Date, cutoff: string | null): string {
  const wib = new Date(at.getTime() + WIB_MS).toISOString();
  const day = wib.slice(0, 10);
  return cutoff && wib.slice(11, 16) >= cutoff ? new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10) : day;
}
/** When a cutoff group of `period` is sent: that day at `cutoff`, Asia/Jakarta. */
export const closesAtOf = (period: string, cutoff: string) => new Date(`${period}T${cutoff}:00+07:00`);

/** Every array field of a request tree (dot paths), outermost only: their fields are filled once per break of a group. */
export function arrayPaths(fields: readonly OpField[], prefix = ""): string[] {
  return fields.flatMap((f) => (f.type === "array" ? [`${prefix}${f.name}`] : f.children?.length ? arrayPaths(f.children, `${prefix}${f.name}.`) : []));
}
const leafPaths = (fields: readonly OpField[], prefix: string): string[] =>
  fields.flatMap((f) => (f.children?.length ? leafPaths(f.children, `${prefix}${f.name}.`) : [`${prefix}${f.name}`]));

/**
 * One payload for a group of breaks (`members`: each break's context at its approval, in joining order). The group's
 * fields are read like recon fields: `group.sum` (the amounts in minor units), `group.count`, `group.period`,
 * `group.key.<field>`; outside an array a money field (`break.amount`, a side's amount) is the group's total of it
 * and any other field the first break's (they share the key). Fields under an
 * array request field are built once per break, one element each (the bank's item list). A total of 0 or below is
 * skipped when the variant says so; an element that can't be built fails naming it (`Items[2].Ref`).
 */
export function buildGroupPayload(v: VariantLike, op: { request: readonly OpField[] }, members: readonly Context[], group: { period: string; keys: readonly { field: string; value: string }[] }, setup: Setup, handled: ReadonlySet<string>): Built {
  // every money field (the break's amount, each side's amount) is the group's total of it, signed (review C1)
  const totals = new Map<string, bigint>();
  for (const m of members) for (const [k, x] of Object.entries(m)) {
    const a = str(x).trim();
    if (isMoneyKey(k) && /^-?\d+$/.test(a)) totals.set(k, (totals.get(k) ?? 0n) + BigInt(a));
  }
  const sum = totals.get("break.amount") ?? 0n;
  if (v.zeroOrNegative === "skip" && sum <= 0n) return { ok: false, code: "skipped", field: "", message: "The group's total is 0 or below: nothing to post." };
  const ctx: Context = {
    ...members[0], ...Object.fromEntries([...totals].map(([k, t]) => [k, t.toString()])), "group.sum": sum.toString(), "group.count": members.length, "group.period": group.period,
    ...Object.fromEntries(group.keys.map((k) => [`group.key.${k.field}`, k.value])),
  };
  const arrays = arrayPaths(op.request).map((path) => ({ path, children: fieldAt(op.request, path)?.children ?? [] }));
  const under = (p: string) => arrays.find((a) => p.startsWith(`${a.path}.`));
  const top = Object.fromEntries(Object.entries(v.mapping).filter(([p]) => !under(p)));
  const inArrays = new Set([...handled, ...arrays.flatMap((a) => leafPaths(a.children, `${a.path}.`))]);
  const built = buildPayload({ ...v, mapping: top, zeroOrNegative: "absolute_swap" }, op, ctx, setup, inArrays);
  if (!built.ok) return built;
  for (const a of arrays) {
    const sub = Object.fromEntries(Object.entries(v.mapping).flatMap(([p, s]) => (p.startsWith(`${a.path}.`) ? [[p.slice(a.path.length + 1), s]] : [])));
    if (!Object.keys(sub).length) continue;
    const rel = new Set([...handled].flatMap((p) => (p.startsWith(`${a.path}.`) ? [p.slice(a.path.length + 1)] : [])));
    const items: unknown[] = [];
    for (const [i, m] of members.entries()) {
      const one = buildPayload({ name: v.name, when: null, mapping: sub, zeroOrNegative: "absolute_swap" }, { request: a.children }, { ...ctx, ...m }, setup, rel);
      if (!one.ok) { const field = `${a.path}[${i + 1}].${one.field}`; return { ...one, field, message: one.message.replace(one.field, field) }; }
      items.push(one.payload);
    }
    setAt(built.payload, a.path, items);
    for (const [p, s] of Object.entries(sourceNames(sub))) built.sources[`${a.path}.${p}`] = s;
  }
  return built;
}
const sourceNames = (m: Readonly<Record<string, Source>>) => Object.fromEntries(Object.entries(m).map(([p, s]) => [p, sourceName(s)]));

/** The first variant whose condition holds on the context (no condition = always), or null (no posting rule, O6). */
export function pickVariant<V extends { when: Condition | null }>(variants: readonly V[], ctx: Context): { index: number; variant: V } | null {
  const index = variants.findIndex((x) => !x.when || evaluate(x.when, ctx));
  return index < 0 ? null : { index, variant: variants[index]! };
}
