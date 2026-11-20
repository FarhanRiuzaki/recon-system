// The column each empty core field is suggested from, by the column's name and type (no React). The wizard applies it
// once per read of the columns and never over a value the user (or a loaded spec) already set.
import type { FieldSpec, SourceSpec } from "@starterkit/shared/contracts/sources";

export type SuggestedCore = "business_date" | "amount_minor" | "currency" | "ext_ref" | "account_ref";

const norm = (s: string) => s.toLowerCase().replace(/[_\s]/g, "");
const names = (...n: string[]) => new Set(n.map(norm));
const fits: Record<SuggestedCore, { names: Set<string>; type: (f: FieldSpec) => boolean }> = {
  business_date: { names: names("business_date", "value_date", "date", "tgl", "tanggal", "trx_date", "txn_date"), type: (f) => f.type === "date" || f.type === "datetime" },
  // the API takes an integer, or a decimal at scale 2
  amount_minor: { names: names("amount_minor", "amount", "amt", "nominal", "jumlah"), type: (f) => f.type === "integer" || (f.type === "decimal" && (f.format?.scale ?? 2) === 2) },
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
