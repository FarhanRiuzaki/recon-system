// The column each empty core field is suggested from, by the column's name and type (no React). The wizard applies it
// once per read of the columns and never over a value the user (or a loaded spec) already set.
import type { FieldSpec, SourcePreviewDto, SourceSpec } from "@starterkit/shared/contracts/sources";
import { type AmountUnit, CURRENCY_EXPONENT, toMinor } from "@starterkit/shared/sources";
import { formatMinor } from "@starterkit/ui/lib/format";

export type SuggestedCore = "business_date" | "amount_minor" | "currency" | "ext_ref" | "account_ref";

const norm = (s: string) => s.toLowerCase().replace(/[_\s]/g, "");
const names = (...n: string[]) => new Set(n.map(norm));
const fits: Record<SuggestedCore, { names: Set<string>; type: (f: FieldSpec) => boolean }> = {
  business_date: { names: names("business_date", "value_date", "date", "tgl", "tanggal", "trx_date", "txn_date"), type: (f) => f.type === "date" || f.type === "datetime" },
  amount_minor: { names: names("amount_minor", "amount", "amt", "nominal", "jumlah"), type: (f) => f.type === "integer" || f.type === "decimal" },
  currency: { names: names("ccy", "currency", "curr", "cur"), type: (f) => f.type === "string" },
  ext_ref: { names: names("txn_ref", "reference", "ref", "trx_id", "txn_id", "ext_ref"), type: (f) => f.type === "string" },
  account_ref: { names: names("account_no", "account", "acct", "rekening", "no_rek"), type: (f) => f.type === "string" },
};

/**
 * Field name per core field whose mapping is still empty. Two columns qualifying for one field: no suggestion; a column
 * already mapped to a core field, or wanted by two, is not suggested.
 */
export function suggestCore(fields: readonly FieldSpec[], mapping: SourceSpec["mapping"]): Partial<Record<SuggestedCore, string>> {
  const empty = (k: SuggestedCore) => { const r = mapping[k]; return !r || ("field" in r && !r.field); };
  const taken = new Set(Object.values(mapping).flatMap((r) => (r && "field" in r && r.field ? [r.field] : [])));
  const pick = Object.fromEntries((Object.keys(fits) as SuggestedCore[]).filter(empty).flatMap((k) => {
    const hit = fields.filter((f) => !taken.has(f.name) && fits[k].names.has(norm(f.name)) && fits[k].type(f));
    return hit.length === 1 ? [[k, hit[0]!.name]] : [];
  })) as Partial<Record<SuggestedCore, string>>;
  const count = new Map<string, number>();
  for (const n of Object.values(pick)) count.set(n, (count.get(n) ?? 0) + 1);
  return Object.fromEntries(Object.entries(pick).filter(([, n]) => count.get(n) === 1));
}

/** The note under a core field while its value is still the suggestion. */
export const coreNote = (k: SuggestedCore, column: string) =>
  `Suggested: ${column}${k === "business_date" ? ", a date column" : k === "amount_minor" ? ", a number column" : ""}.`;

export const UNIT_HINT: Record<AmountUnit, string> = { major: "rupiah, dollars · 1500 = 1,500.00", minor: "sen, cents · 1500 = 15.00" };

/**
 * The unit an amount column suggests: a decimal is in currency units; an integer named *_minor or *_cents in minor
 * units; any other column suggests nothing (the user chooses). `note` is what the field says while it is still the value.
 */
export function suggestUnit(f: FieldSpec | undefined): { unit: AmountUnit; note: string } | null {
  if (f?.type === "decimal") return { unit: "major", note: `Suggested: currency units. ${f.name} is a decimal number.` };
  const end = f?.type === "integer" ? /_(minor|cents)$/i.exec(f.name)?.[1]?.toLowerCase() : undefined;
  return end ? { unit: "minor", note: `Suggested: minor units. ${f!.name} is a whole number and its name ends in _${end}.` } : null;
}

/**
 * The example under "Amount is in": per currency of the preview's rows, its first row's amount as the source wrote it
 * and what `unit` stores ("First IDR row: 2551779 is stored as IDR 25,517.79."), or why that row would be quarantined.
 */
export function unitExamples(records: SourcePreviewDto["records"], unit: AmountUnit): string[] {
  const first = new Map<string, string>();
  for (const r of records) if (r.currency && r.amountText !== null && !first.has(r.currency)) first.set(r.currency, r.amountText);
  return [...first].flatMap(([code, text]) => {
    const exp = CURRENCY_EXPONENT[code];
    const m = /^(-?\d+)(?:\.(\d+))?$/.exec(text);
    if (exp === undefined || !m) return [];
    const x = toMinor(BigInt(m[1]! + (m[2] ?? "")), m[2]?.length ?? 0, unit, exp, code);
    return [`First ${code} row: ${text} ${"v" in x ? `is stored as ${code} ${formatMinor(x.v, exp)}` : `can't be stored: ${x.why}`}.`];
  });
}

/**
 * The draft with its amount unit suggested from the amount column when no unit is set, or when the one set is still
 * the earlier suggestion (the column changed); a unit the user chose stays.
 */
export function withUnit<D extends { spec: SourceSpec; unitHint?: { unit: AmountUnit; note: string } }>(d: D): D {
  const a = d.spec.mapping.amount_minor;
  if (!a || (a.unit && a.unit !== d.unitHint?.unit)) return d;
  const sug = "field" in a ? suggestUnit(d.spec.fields.find((f) => f.name === a.field)) : null;
  const { unit: _old, ...ref } = a;
  return { ...d, unitHint: sug ?? undefined, spec: { ...d.spec, mapping: { ...d.spec.mapping, amount_minor: sug ? { ...ref, unit: sug.unit } : ref } } };
}
