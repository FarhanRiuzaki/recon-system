// The field catalog and conditions of a recon's approval (and, later, posting) rules (DEC-052 rev 2, design §4.3),
// zod-free and pure: the engine evaluates a rule with it, the editor previews and reads it as a sentence with it.
// The catalog follows the recon version's sides (their sources' record fields), never a fixed list.
import { CORE_FIELDS, FIELD_LABEL, type RecordField } from "./recon";

export type CatalogKind = "number" | "money" | "text" | "date" | "list";
export type CatalogGroup = "break" | "recon" | "side_a" | "side_b";
export type CatalogField = { key: string; label: string; group: CatalogGroup; kind: CatalogKind };

export const OPS = ["eq", "ne", "in", "not_in", "starts_with", "contains", "gte", "gt", "lte", "lt", "empty", "not_empty"] as const;
export type Op = (typeof OPS)[number];
export const OP_TEXT: Record<Op, string> = {
  eq: "is", ne: "is not", in: "is one of", not_in: "is not one of", starts_with: "starts with", contains: "contains",
  gte: "is at least", gt: "is more than", lte: "is at most", lt: "is less than", empty: "is empty", not_empty: "is not empty",
};
/** The comparisons each kind of field offers. */
export const OPS_BY_KIND: Record<CatalogKind, readonly Op[]> = {
  money: ["gte", "gt", "lte", "lt", "eq", "ne", "empty", "not_empty"],
  number: ["gte", "gt", "lte", "lt", "eq", "ne", "empty", "not_empty"],
  date: ["gte", "gt", "lte", "lt", "eq", "empty", "not_empty"],
  text: ["eq", "ne", "in", "not_in", "starts_with", "contains", "empty", "not_empty"],
  list: ["in", "not_in", "eq", "ne", "empty", "not_empty"],
};
export const NO_VALUE_OPS: readonly Op[] = ["empty", "not_empty"];
export const LIST_OPS: readonly Op[] = ["in", "not_in"];

export type Clause = { field: string; op: Op; value?: string | string[] };
export type Condition = { all: (Clause | Condition)[] } | { any: (Clause | Condition)[] };
export type Context = Readonly<Record<string, string | number | null | undefined>>;

/** The fields every break has, whatever its recon reads. */
export const BREAK_FIELDS: readonly CatalogField[] = [
  { key: "break.amount", label: "Amount", group: "break", kind: "money" },
  { key: "break.currency", label: "Currency", group: "break", kind: "list" },
  { key: "break.business_date", label: "Business date", group: "break", kind: "date" },
  { key: "break.age_days", label: "Age in days", group: "break", kind: "number" },
  { key: "break.side", label: "Side", group: "break", kind: "list" },
  { key: "break.reason", label: "Break reason", group: "break", kind: "list" },
  { key: "break.state", label: "Break state", group: "break", kind: "list" },
  { key: "break.reference", label: "Reference", group: "break", kind: "text" },
  { key: "recon.code", label: "Recon code", group: "recon", kind: "text" },
];

/** "e2e_id" → "E2e id". */
const humanise = (name: string) => { const s = name.replace(/_/g, " ").trim(); return s.charAt(0).toUpperCase() + s.slice(1); };
const kindOf = (ref: string, f: RecordField): CatalogKind =>
  ref === "amount_minor" ? "money" : f.kind === "decimal" ? "number" : f.kind === "date" ? "date" : f.kind === "boolean" ? "list" : "text";

/** The catalog of a recon version: the break's fields, then each side's record fields under its label. */
export function buildCatalog(sides: readonly [{ label: string; fields: ReadonlyMap<string, RecordField> }, { label: string; fields: ReadonlyMap<string, RecordField> }]): CatalogField[] {
  const out = [...BREAK_FIELDS];
  sides.forEach((s, i) => {
    const group: CatalogGroup = i === 0 ? "side_a" : "side_b";
    for (const [ref, f] of s.fields) {
      const name = ref.startsWith("attrs.") ? humanise(ref.slice(6)) : FIELD_LABEL[ref as keyof typeof CORE_FIELDS] ?? humanise(ref);
      out.push({ key: `${group}.${ref}`, label: `${s.label} · ${name}`, group, kind: kindOf(ref, f) });
    }
  });
  return out;
}

const isGroup = (x: Clause | Condition): x is Condition => "all" in x || "any" in x;
const norm = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());
const INT = /^-?\d+$/, DEC = /^-?\d+(\.\d+)?$/;
/** -1, 0, 1: whole numbers as bigint (money in minor units), decimals as numbers, anything else as text (ISO dates sort). */
function compare(a: string, b: string): number {
  if (INT.test(a) && INT.test(b)) { const x = BigInt(a), y = BigInt(b); return x < y ? -1 : x > y ? 1 : 0; }
  if (DEC.test(a) && DEC.test(b)) return Math.sign(Number(a) - Number(b));
  return a < b ? -1 : a > b ? 1 : 0;
}
function holds(c: Clause, ctx: Context): boolean {
  const v = norm(ctx[c.field]);
  if (c.op === "empty") return v === "";
  if (c.op === "not_empty") return v !== "";
  if (v === "") return false; // a field the data doesn't have fails its clause
  const list = (Array.isArray(c.value) ? c.value : [c.value ?? ""]).map(norm);
  const one = list[0] ?? "";
  switch (c.op) {
    case "eq": return v === one;
    case "ne": return v !== one;
    case "in": return list.includes(v);
    case "not_in": return !list.includes(v);
    case "starts_with": return v.toLowerCase().startsWith(one.toLowerCase());
    case "contains": return v.toLowerCase().includes(one.toLowerCase());
    case "gte": return compare(v, one) >= 0;
    case "gt": return compare(v, one) > 0;
    case "lte": return compare(v, one) <= 0;
    case "lt": return compare(v, one) < 0;
  }
}

/** Whether `c` holds on `ctx` (a field missing from `ctx` fails its clause; nothing throws). */
export function evaluate(c: Condition, ctx: Context): boolean {
  const parts = "all" in c ? c.all : c.any;
  const ok = (p: Clause | Condition) => (isGroup(p) ? evaluate(p, ctx) : holds(p, ctx));
  return "all" in c ? parts.every(ok) : parts.some(ok);
}

/** Every field a condition reads. */
export function conditionFields(c: Condition): string[] {
  return ("all" in c ? c.all : c.any).flatMap((p) => (isGroup(p) ? conditionFields(p) : [p.field]));
}

/** A condition as a sentence: "Amount is at least 2500000000 and BI · Channel is one of RTGS". */
export function conditionText(c: Condition, catalog: readonly CatalogField[]): string {
  const label = (k: string) => catalog.find((f) => f.key === k)?.label ?? "A field no longer read";
  const parts = ("all" in c ? c.all : c.any).map((p) => {
    if (isGroup(p)) return `(${conditionText(p, catalog)})`;
    const v = Array.isArray(p.value) ? p.value.join(", ") : p.value ?? "";
    return NO_VALUE_OPS.includes(p.op) ? `${label(p.field)} ${OP_TEXT[p.op]}` : `${label(p.field)} ${OP_TEXT[p.op]} ${v}`;
  });
  return parts.join("all" in c ? " and " : " or ");
}
