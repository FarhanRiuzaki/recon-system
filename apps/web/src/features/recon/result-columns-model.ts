// A recon's Operation result columns as the Configuration edits them (spec "Column setup"): what may be a column, a
// pick turned into a column, moving one. Pure. The API (recon result-columns.ts) stays the judge on save.
import type { ResultColumn } from "@starterkit/shared/contracts/results";
import { FIELD_LABEL } from "@starterkit/shared/recon";
import { RECON_INFO_FIELDS, RECON_INFO_LABEL, type ReconInfoField, RESULT_COLUMNS_MAX, RESULT_LABEL_MAX } from "@starterkit/shared/results";
import { fieldRefs, type SideFields } from "./spec-model";

export type ColumnSide = { label: string; fields: SideFields };
export type ColumnChoice = { value: string; label: string; group: string };

/** A field as a column names it: a core field by its label, a stored one by the name its source keeps. */
export const fieldText = (ref: string) => (ref.startsWith("attrs.") ? ref.slice(6) : FIELD_LABEL[ref as keyof typeof FIELD_LABEL] ?? ref);
const valueOf = (c: Pick<ResultColumn, "kind" | "field">) => `${c.kind}:${c.field}`;

/** What may be a column: each side's fields (under the side's name; none until its source is read), then recon info. */
export function columnChoices(sides: readonly [ColumnSide, ColumnSide]): ColumnChoice[] {
  const side = (i: 0 | 1) => fieldRefs(sides[i].fields).map((ref) => ({ value: `${i ? "b" : "a"}:${ref}`, label: fieldText(ref), group: sides[i].label }));
  return [...side(0), ...side(1), ...RECON_INFO_FIELDS.map((f) => ({ value: `recon:${f}`, label: RECON_INFO_LABEL[f], group: "Recon" }))];
}

/** The pick `value` ("a:ext_ref", "recon:reason") added last, headed by its side's name and label; refused once there or at 20. */
export function addColumn(columns: readonly ResultColumn[], value: string, sides: readonly [ColumnSide, ColumnSide]): { columns: ResultColumn[] } | { error: string } {
  if (columns.some((c) => valueOf(c) === value)) return { error: "Already a column" };
  if (columns.length >= RESULT_COLUMNS_MAX) return { error: `At most ${RESULT_COLUMNS_MAX} columns` };
  const [kind, field] = [value.slice(0, value.indexOf(":")), value.slice(value.indexOf(":") + 1)];
  const col: ResultColumn = kind === "recon"
    ? { kind, field: field as ReconInfoField, label: RECON_INFO_LABEL[field as ReconInfoField] }
    : { kind: kind as "a" | "b", field, label: `${sides[kind === "a" ? 0 : 1].label} ${fieldText(field).replace(/^[A-Z](?=[a-z])/, (x) => x.toLowerCase())}`.slice(0, RESULT_LABEL_MAX) };
  return { columns: [...columns, col] };
}

/** Column `i` one place up (-1) or down (1); past an end, the same list. */
export function moveColumn(columns: ResultColumn[], i: number, by: -1 | 1): ResultColumn[] {
  const j = i + by;
  if (j < 0 || j >= columns.length) return columns;
  const next = [...columns];
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/** A column's pick value, its key in a list. */
export const columnValue = valueOf;
