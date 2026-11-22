// Mapping a recon's data onto a bank operation's request (design 2026-11-22-recon-approval-and-posting §4.5), zod-free
// and pure: the sources a request field takes, the changes (transforms) applied to a value, and the references a
// template makes, so the contract and the editor check the same way.

import { type Condition, type Context, evaluate } from "./conditions";
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

/**
 * The request payload a variant builds for a break's context: each mapped field from its source (numbers as numbers for
 * numeric fields), refused — naming the field — when a value is longer than the bank takes, a lookup misses, or a
 * required field ends up empty (fields in `handled` are filled by the operation itself: fixed or auto). An amount of 0
 * is skipped when the variant says so.
 * ponytail: numbers beyond 2^53 lose precision as JSON numbers; send such fields as text (type string) until a bank needs them.
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
    setAt(payload, path, f?.type === "numeric" && /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value);
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

/** The first variant whose condition holds on the context (no condition = always), or null (no posting rule, O6). */
export function pickVariant<V extends { when: Condition | null }>(variants: readonly V[], ctx: Context): { index: number; variant: V } | null {
  const index = variants.findIndex((x) => !x.when || evaluate(x.when, ctx));
  return index < 0 ? null : { index, variant: variants[index]! };
}
