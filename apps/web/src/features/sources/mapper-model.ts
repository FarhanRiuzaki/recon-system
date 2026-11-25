// The source mapper (DEC-059), pure: a draft spec as the field map's graph (the file's columns and computed values on
// the left, the core record and its folded extra attributes on the right, a line per column mapping), and the edits
// the mapper makes to the draft. The wizard applies the spec these answer.
import type { MapGraph, MapTargetRow } from "@/components/field-map/graph";
import { computeSteps } from "@starterkit/shared/compute";
import type { SourceSpec, ValueRef } from "@starterkit/shared/contracts/sources";
import { attrNameOf } from "./spec-draft";

export const CORE_ROWS = ["business_date", "amount_minor", "currency", "direction", "event_time", "ext_ref", "account_ref"] as const;
export type CoreRow = (typeof CORE_ROWS)[number];
const LABEL: Record<CoreRow, string> = {
  business_date: "Business date", amount_minor: "Amount", currency: "Currency", direction: "Direction", event_time: "Event time", ext_ref: "Reference", account_ref: "Account",
};
const REQUIRED = "The business date is required. Map it to a column or a date preset.";

type Mapping = SourceSpec["mapping"];
type Ref = ValueRef | (ValueRef & { unit?: "major" | "minor" });

/** A formula's JSON step on a column (`data.code.rc` as computeCel writes it), or null. */
function jsonPathOf(r: Ref): { column: string; path: string } | null {
  if (!("cel" in r)) return null;
  const b = computeSteps(r.cel);
  return b?.steps.length === 1 && b.steps[0]!.type === "json" ? { column: b.source, path: String(b.steps[0]!.args[0]) } : null;
}

/** A formula in words for its row. */
const formulaNote = (cel: string) => (cel === "file_date" ? "File name's date" : cel === "arrived_date" ? "Day it arrives" : cel);

/** The graph of a draft spec. `examples`: a sample value per column (the preview's); `q` narrows the columns. */
export function sourceGraph(spec: SourceSpec, examples: Readonly<Record<string, string>>, opts: { q?: string } = {}): MapGraph {
  const q = opts.q?.trim().toLowerCase();
  const names = new Set(spec.fields.map((f) => f.name));
  const columns = spec.fields.filter((f) => !q || f.name.toLowerCase().includes(q)).map((f) => ({ key: f.name, label: examples[f.name] ? `${f.name} · ${examples[f.name]}` : f.name, kind: f.type }));
  const computed = Object.keys(spec.derive ?? {}).map((n) => ({ key: n, label: n, kind: "formula" }));
  const edges: MapGraph["edges"] = [];
  const request: MapTargetRow[] = CORE_ROWS.map((k) => {
    const r = (spec.mapping as unknown as Record<string, Ref | undefined>)[k];
    const row: MapTargetRow = { path: k, name: LABEL[k], depth: 0, leaf: true, required: k === "business_date", type: "", maxLength: null, filledBy: null, mapped: null };
    if (k === "currency" && !r && spec.currency) return { ...row, mapped: "const", note: `${spec.currency} for every row` };
    if (!r) return row;
    if ("field" in r) {
      if (!names.has(r.field) && !Object.hasOwn(spec.derive ?? {}, r.field)) return { ...row, broken: true, note: `Column ${r.field} isn't in the file any more` };
      edges.push({ id: k, source: names.has(r.field) ? "columns" : "computed", row: r.field, target: k, label: null });
      return { ...row, mapped: "field" };
    }
    const json = jsonPathOf(r);
    if (json && names.has(json.column)) { edges.push({ id: k, source: "columns", row: json.column, target: k, label: json.path, dashed: true }); return { ...row, mapped: "cel" }; }
    return { ...row, mapped: "cel", note: formulaNote(r.cel) };
  });
  request.push({ path: "attrs", name: "Extra attributes", depth: 0, leaf: false, required: false, type: "", maxLength: null, filledBy: null, mapped: null, folded: Object.keys(spec.mapping.attrs ?? {}).length });
  return {
    sources: [{ id: "columns", title: "File columns", caption: null, rows: columns }, ...(computed.length ? [{ id: "computed", title: "Computed", caption: null, rows: computed }] : [])],
    request, edges, missing: spec.mapping.business_date ? [] : ["business_date"],
  };
}

const withMapping = (spec: SourceSpec, m: Partial<Mapping>): SourceSpec => ({ ...spec, mapping: { ...spec.mapping, ...m } as Mapping });

/** Column (or computed value) `column` feeds core row `target`, replacing what fed it; the amount keeps its unit. */
export function connect(spec: SourceSpec, column: string, target: CoreRow): SourceSpec {
  if (target === "amount_minor") {
    const unit = spec.mapping.amount_minor?.unit;
    return withMapping(spec, { amount_minor: { field: column, ...(unit ? { unit } : {}) } });
  }
  const next = withMapping(spec, { [target]: { field: column } } as Partial<Mapping>);
  return target === "currency" ? { ...next, currency: undefined } : next;
}

/** Core row `target` loses its mapping; the business date can't. */
export function disconnect(spec: SourceSpec, target: CoreRow): SourceSpec | { refused: string } {
  if (target === "business_date") return { refused: REQUIRED };
  return withMapping(spec, { [target]: undefined } as Partial<Mapping>);
}

/** Where core row `target` takes its value from, set in the inspector. */
export function setSource(spec: SourceSpec, target: CoreRow, v: { field: string } | { cel: string } | { preset: "file_date" | "arrived_date" } | { currency: string }): SourceSpec {
  if ("currency" in v) return { ...withMapping(spec, { currency: undefined }), currency: v.currency };
  if ("field" in v) return connect(spec, v.field, target);
  const cel = "preset" in v ? v.preset : v.cel;
  if (target === "amount_minor") return withMapping(spec, { amount_minor: { cel, ...(spec.mapping.amount_minor?.unit ? { unit: spec.mapping.amount_minor.unit } : {}) } });
  return withMapping(spec, { [target]: { cel } } as Partial<Mapping>);
}

/** Column `column` kept as an extra attribute (under `name`, its own by default) or not. */
export function toggleAttr(spec: SourceSpec, column: string, on: boolean, name = attrNameOf(column)): SourceSpec {
  const attrs = Object.fromEntries(Object.entries(spec.mapping.attrs ?? {}).filter(([, r]) => !("field" in r && r.field === column)));
  return withMapping(spec, { attrs: on ? { ...attrs, [name]: { field: column } } : attrs });
}

/** Step 2's summary: "2 core fields mapped · 2 extra attributes · 1 computed". */
export function summaryLine(spec: SourceSpec): string {
  const core = CORE_ROWS.filter((k) => (spec.mapping as Record<string, unknown>)[k] || (k === "currency" && spec.currency)).length;
  const attrs = Object.keys(spec.mapping.attrs ?? {}).length;
  const computed = Object.keys(spec.derive ?? {}).length;
  const n = (x: number, one: string, many: string) => `${x} ${x === 1 ? one : many}`;
  return [n(core, "core field mapped", "core fields mapped"), n(attrs, "extra attribute", "extra attributes"), ...(computed ? [`${computed} computed`] : [])].join(" · ");
}
