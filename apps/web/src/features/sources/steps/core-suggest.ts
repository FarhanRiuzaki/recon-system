// The column each empty core field is suggested from, by the column's name and type (no React). The wizard applies it
// once per read of the columns and never over a value the user (or a loaded spec) already set.
import type { FieldSpec, SourcePreviewDto, SourceSpec } from "@starterkit/shared/contracts/sources";
import { type AmountUnit, CURRENCY_EXPONENT, currencyCode, toMinor } from "@starterkit/shared/sources";
import { formatMinor } from "@starterkit/ui/lib/format";

export type SuggestedCore = "business_date" | "amount_minor" | "currency" | "ext_ref" | "account_ref";

const norm = (s: string) => s.toLowerCase().replace(/[_\s]/g, "");
/** A column name's words: "end_to_end_id" → end, to, end, id; "settledAt" → settled, at. */
const words = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * What makes a column fit a core field (owner, 21 Nov: dynamic, not a fixed list of names): its type must fit; then it
 * scores by its name (a whole known name 3, a known word in it 2, a weaker word 1) and, given examples, by its values
 * (every example a currency code the product knows: 3). `avoid`: words that mean another thing (a reason code is no
 * reference).
 */
type Fit = { type: (f: FieldSpec) => boolean; names: string[]; strong: string[]; weak?: string[]; avoid?: string[]; values?: (ex: string[]) => boolean };
const fits: Record<SuggestedCore, Fit> = {
  business_date: { type: (f) => f.type === "date" || f.type === "datetime", names: ["business_date", "value_date", "date", "tgl", "tanggal", "trx_date", "txn_date"],
    strong: ["business", "value", "tgl", "tanggal", "posting", "booking"], weak: ["date"] },
  amount_minor: { type: (f) => f.type === "integer" || f.type === "decimal", names: ["amount_minor", "amount", "amt", "nominal", "jumlah"],
    strong: ["amount", "amt", "nominal", "jumlah"], avoid: ["balance", "saldo", "fee", "no", "id"] },
  currency: { type: (f) => f.type === "string", names: ["ccy", "currency", "curr", "cur"], strong: ["ccy", "currency", "curr"],
    values: (ex) => ex.length > 0 && ex.every((v) => currencyCode(v) !== null) },
  ext_ref: { type: (f) => f.type === "string", names: ["txn_ref", "reference", "ref", "trx_id", "txn_id", "ext_ref", "end_to_end_id", "e2e_id"],
    strong: ["ref", "reference", "e2e", "endtoend", "rrn", "trx", "txn"], avoid: ["reason", "status", "channel", "name", "bank", "account", "proxy"] },
  account_ref: { type: (f) => f.type === "string", names: ["account_no", "account", "acct", "rekening", "no_rek"], strong: ["account", "acct", "rekening", "rek", "norek"],
    avoid: ["name", "bank", "proxy"] },
};
const known = Object.fromEntries(Object.entries(fits).map(([k, x]) => [k, new Set(x.names.map(norm))])) as Record<SuggestedCore, Set<string>>;

/** How well column `f` fits core field `k` (0 = not at all). */
function score(k: SuggestedCore, f: FieldSpec, ex: string[]): number {
  const x = fits[k];
  if (!x.type(f)) return 0;
  const w = words(f.name), joined = w.join("");
  if (x.avoid?.some((a) => w.includes(a))) return 0;
  let n = known[k].has(norm(f.name)) ? 3 : 0;
  if (!n && (x.strong.some((s) => w.includes(s) || joined.includes(s)))) n = 2;
  if (!n && x.weak?.some((s) => w.includes(s))) n = 1;
  if (x.values?.(ex)) n += 3;
  return n;
}

/**
 * Field name per core field whose mapping is still empty: the column that fits it best, by type, name and (given) its
 * example values. Two columns fitting one field equally well: no suggestion (the user picks); a column already mapped
 * to a core field, or the best for two, is not suggested.
 */
export function suggestCore(fields: readonly FieldSpec[], mapping: SourceSpec["mapping"], examples: ReadonlyMap<string, readonly string[]> = new Map()): Partial<Record<SuggestedCore, string>> {
  const empty = (k: SuggestedCore) => { const r = mapping[k]; return !r || ("field" in r && !r.field); };
  const taken = new Set(Object.values(mapping).flatMap((r) => (r && "field" in r && r.field ? [r.field] : [])));
  const pick = Object.fromEntries((Object.keys(fits) as SuggestedCore[]).filter(empty).flatMap((k) => {
    const scored = fields.filter((f) => !taken.has(f.name)).map((f) => ({ f, n: score(k, f, [...(examples.get(f.name) ?? [])].filter(Boolean)) })).filter((x) => x.n > 0);
    const top = Math.max(0, ...scored.map((x) => x.n));
    const best = scored.filter((x) => x.n === top);
    return best.length === 1 ? [[k, best[0]!.f.name]] : [];
  })) as Partial<Record<SuggestedCore, string>>;
  const count = new Map<string, number>();
  for (const n of Object.values(pick)) count.set(n, (count.get(n) ?? 0) + 1);
  return Object.fromEntries(Object.entries(pick).filter(([, n]) => count.get(n) === 1));
}

/** The note under a core field while its value is still the suggestion. */
export const coreNote = (_k: SuggestedCore, _column: string) =>
  "Suggested";

export const UNIT_HINT: Record<AmountUnit, string> = { major: "rupiah, dollars · 1500 = 1,500.00", minor: "sen, cents · 1500 = 15.00" };

/**
 * The unit an amount column suggests: a decimal is in currency units; an integer named *_minor or *_cents in minor
 * units; any other column suggests nothing (the user chooses). `note` is what the field says while it is still the value.
 */
export function suggestUnit(f: FieldSpec | undefined): { unit: AmountUnit; note: string } | null {
  if (f?.type === "decimal") return { unit: "major", note: "Suggested" };
  const end = f?.type === "integer" ? /_(minor|cents)$/i.exec(f.name)?.[1]?.toLowerCase() : undefined;
  return end ? { unit: "minor", note: "Suggested" } : null;
}

/**
 * The example under "Amount is in": per currency of the preview's rows, its first row's amount as the source wrote it
 * and what `unit` stores ("107919 → IDR 1,079.19"), or why that row would be quarantined.
 */
export function unitExamples(records: SourcePreviewDto["records"], unit: AmountUnit): string[] {
  const first = new Map<string, string>();
  for (const r of records) if (r.currency && r.amountText !== null && !first.has(r.currency)) first.set(r.currency, r.amountText);
  return [...first].flatMap(([code, text]) => {
    const exp = CURRENCY_EXPONENT[code];
    const m = /^(-?\d+)(?:\.(\d+))?$/.exec(text);
    if (exp === undefined || !m) return [];
    const x = toMinor(BigInt(m[1]! + (m[2] ?? "")), m[2]?.length ?? 0, unit, exp, code);
    return [`${text} → ${"v" in x ? `${code} ${formatMinor(x.v, exp)}` : `can't be stored: ${x.why}`}`];
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
