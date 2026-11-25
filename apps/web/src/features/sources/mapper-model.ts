// The source mapper (DEC-059), pure: a draft spec as the field map's graph (the source's columns and computed values on
// the left, the core record and its folded extra attributes on the right, a line per column mapping), and the edits
// the mapper makes to the draft. The wizard applies the spec these answer.
import type { MapGraph, MapTargetRow } from "@/components/field-map/graph";
import { computeCel, computeSteps } from "@starterkit/shared/compute";
import type { FieldSpec, SourceSpec, ValueRef } from "@starterkit/shared/contracts/sources";
import type { AmountUnit } from "@starterkit/shared/sources";
import { attrNameOf, storeAs, storedName, storedNameProblem } from "./spec-draft";
import { amountProblems, ctl, mappingProblem } from "./steps/model";

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
  const computed = Object.keys(spec.derive ?? {}).map((n) => ({ key: n, label: n, kind: "formula" }));
  const edges: MapGraph["edges"] = [];
  const request: MapTargetRow[] = CORE_ROWS.map((k) => {
    const r = (spec.mapping as unknown as Record<string, Ref | undefined>)[k];
    const row: MapTargetRow = { path: k, name: LABEL[k], depth: 0, leaf: true, required: k === "business_date", type: "", maxLength: null, filledBy: null, mapped: null };
    if (k === "currency" && !r && spec.currency) return { ...row, mapped: "const", note: `${spec.currency} for every row` };
    // the wizard's "not picked yet" business date is { field: "" }
    if (!r || ("field" in r && !r.field)) return row;
    if ("field" in r) {
      if (!names.has(r.field) && !Object.hasOwn(spec.derive ?? {}, r.field)) return { ...row, broken: true, note: `Column ${r.field} isn't in the source any more` };
      edges.push({ id: k, source: names.has(r.field) ? "columns" : "computed", row: r.field, target: k, label: null });
      return { ...row, mapped: "field" };
    }
    const json = jsonPathOf(r);
    if (json && !names.has(json.column)) return { ...row, broken: true, note: `Column ${json.column} isn't in the source any more` };
    if (json) { edges.push({ id: k, source: "columns", row: json.column, target: k, label: json.path, dashed: true }); return { ...row, mapped: "cel" }; }
    return { ...row, mapped: "cel", note: formulaNote(r.cel) };
  });
  request.push({ path: "attrs", name: "Extra attributes", depth: 0, leaf: false, required: false, type: "", maxLength: null, filledBy: null, mapped: null, folded: Object.keys(spec.mapping.attrs ?? {}).length });
  // a search narrows the columns but keeps every one a line starts from, so no line ends in nothing
  const fed = new Set(edges.filter((e) => e.source === "columns").map((e) => e.row));
  const kept = new Set(Object.values(spec.mapping.attrs ?? {}).flatMap((r) => ("field" in r ? [r.field] : [])));
  const columns = spec.fields.filter((f) => !q || fed.has(f.name) || f.name.toLowerCase().includes(q))
    .map((f) => ({ key: f.name, label: examples[f.name] ? `${f.name} · ${examples[f.name]}` : f.name, kind: kept.has(f.name) ? `${f.type} · extra attribute` : f.type }));
  return {
    sources: [{ id: "columns", title: "Source columns", caption: null, rows: columns }, ...(computed.length ? [{ id: "computed", title: "Computed", caption: null, rows: computed }] : [])],
    request, edges, missing: request[0]!.mapped || request[0]!.broken ? [] : ["business_date"],
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
  if (target === "currency") return { ...withMapping(spec, { currency: undefined }), currency: undefined };
  return withMapping(spec, { [target]: undefined } as Partial<Mapping>);
}

/** Where core row `target` takes its value from, set in the inspector. */
export function setSource(spec: SourceSpec, target: CoreRow, v: { field: string } | { cel: string } | { preset: "file_date" | "arrived_date" } | { currency: string }): SourceSpec {
  if ("currency" in v) return { ...withMapping(spec, { currency: undefined }), currency: v.currency.trim() || undefined };
  if ("field" in v) return connect(spec, v.field, target);
  const cel = "preset" in v ? v.preset : v.cel;
  if (target === "amount_minor") return withMapping(spec, { amount_minor: { cel, ...(spec.mapping.amount_minor?.unit ? { unit: spec.mapping.amount_minor.unit } : {}) } });
  return withMapping(spec, { [target]: { cel } } as Partial<Mapping>);
}

/** Column `column` kept as an extra attribute (under `name`, its own by default) or not. */
export function toggleAttr(spec: SourceSpec, column: string, on: boolean, name = attrNameOf(column)): SourceSpec {
  const attrs = Object.fromEntries(Object.entries(spec.mapping.attrs ?? {}).filter(([, r]) => !("field" in r && r.field === column)));
  if (!on) return withMapping(spec, { attrs });
  // a name another column already keeps takes the next free suffix (amount, amount_2), as step 2 does
  let free = name;
  for (let i = 2; Object.hasOwn(attrs, free); i++) free = `${name}_${i}`;
  return withMapping(spec, { attrs: { ...attrs, [free]: { field: column } } });
}

/** Step 2's summary: "2 core fields mapped · 2 extra attributes · 1 computed". */
export function summaryLine(spec: SourceSpec): string {
  const core = CORE_ROWS.filter((k) => (spec.mapping as Record<string, unknown>)[k] || (k === "currency" && spec.currency)).length;
  const attrs = Object.keys(spec.mapping.attrs ?? {}).length;
  const computed = Object.keys(spec.derive ?? {}).length;
  const n = (x: number, one: string, many: string) => `${x} ${x === 1 ? one : many}`;
  return [n(core, "core field mapped", "core fields mapped"), n(attrs, "extra attribute", "extra attributes"), ...(computed ? [`${computed} computed`] : [])].join(" · ");
}

/** The amount's unit (currency units or minor units). */
export function setUnit(spec: SourceSpec, unit: AmountUnit): SourceSpec {
  const a = spec.mapping.amount_minor;
  return a ? withMapping(spec, { amount_minor: { ...a, unit } }) : spec;
}

/** Core row `target` reads `path` inside column `column`'s JSON (a dashed line on the canvas). */
export function setJsonPath(spec: SourceSpec, target: CoreRow, column: string, path: string): SourceSpec {
  return setSource(spec, target, { cel: computeCel(column, [{ type: "json", args: [path] }]) });
}

/** The problem step 2 would show on core row `k` (its mapping, its amount unit), or null. */
export function rowProblem(spec: SourceSpec, k: CoreRow): string | null {
  const ids = new Set([ctl(`mapping.${k}`), ...(k === "amount_minor" ? [ctl("mapping.amount_minor.unit")] : [])]);
  const m = mappingProblem(spec);
  if (m && ids.has(m.id)) return m.reason;
  const a = spec.mapping.amount_minor;
  if (k === "amount_minor" && a && "field" in a) {
    const f = spec.fields.find((x) => x.name === a.field);
    if (f && f.type !== "integer" && f.type !== "decimal") return `The amount needs a whole number or a decimal column. Change the type of ${f.name}, or pick another column.`;
  }
  return amountProblems(spec).find((p) => ids.has(p.id))?.reason ?? null;
}

/** Column `name`'s type (with the format it starts with, as step 2 sets it) or whether it can be empty. */
export function setColumn(spec: SourceSpec, name: string, patch: { type?: FieldSpec["type"]; nullable?: boolean }): SourceSpec {
  return { ...spec, fields: spec.fields.map((f) => {
    if (f.name !== name) return f;
    if (patch.type && patch.type !== f.type) return { ...f, ...patch, format: patch.type === "decimal" ? { scale: 2 } : patch.type === "date" ? { date: "yyyy-MM-dd" } : undefined };
    return { ...f, ...patch };
  }) };
}

/** Column `column`'s kept attribute renamed to `name` (its place kept), or why the name can't be used. */
export function renameAttr(spec: SourceSpec, column: string, name: string): SourceSpec | { refused: string } {
  if (storedName(spec, column) === null) return { refused: `Keep ${column} as an extra attribute first.` };
  const why = storedNameProblem(name, column, spec);
  return why ? { refused: why } : storeAs(spec, column, name);
}

/** What the column inspector shows. */
export function columnInfo(spec: SourceSpec, name: string): { type: FieldSpec["type"]; nullable: boolean; stored: string | null } | null {
  const f = spec.fields.find((x) => x.name === name);
  return f ? { type: f.type, nullable: f.nullable, stored: storedName(spec, name) } : null;
}

/** Extra attribute `name` no longer kept (one from a column or from a formula). */
export function removeAttr(spec: SourceSpec, name: string): SourceSpec {
  return withMapping(spec, { attrs: Object.fromEntries(Object.entries(spec.mapping.attrs ?? {}).filter(([k]) => k !== name)) });
}

/** A new computed column: the next free computed_N, starting from the first text column (a remark, a reference). */
export function addComputed(spec: SourceSpec): { spec: SourceSpec; name: string } {
  const taken = new Set([...spec.fields.map((f) => f.name), ...Object.keys(spec.derive ?? {})]);
  let n = 1;
  while (taken.has(`computed_${n}`)) n++;
  const name = `computed_${n}`;
  const from = (spec.fields.find((f) => f.type === "string") ?? spec.fields[0])?.name ?? "";
  return { name, spec: { ...spec, derive: { ...spec.derive, [name]: computeCel(from, []) } } };
}

/** Column `name`'s format with `patch` merged in; an empty value is removed. */
export function setFormat(spec: SourceSpec, name: string, patch: NonNullable<FieldSpec["format"]>): SourceSpec {
  return { ...spec, fields: spec.fields.map((f) => (f.name !== name ? f : {
    ...f, format: Object.fromEntries(Object.entries({ ...f.format, ...patch }).filter(([, v]) => v !== undefined && v !== "")),
  })) };
}

/** Where the mapper opens for a step 2 problem's control id: a core field, a column, or null (not the mapper's). */
export function problemTarget(spec: SourceSpec, id: string): string | null {
  const core = CORE_ROWS.find((k) => id === ctl(`mapping.${k}`) || id.startsWith(`${ctl(`mapping.${k}`)}-`));
  if (core) return core;
  const col = /^src-fields-(\d+)(?:-|$)/.exec(id);
  const f = col ? spec.fields[Number(col[1])] : undefined;
  return f ? `col:${f.name}` : null;
}

/** Computed column `from` renamed to `to`, with every use moved (core fields, attributes, formulas built on it), or why not. */
export function renameComputed(spec: SourceSpec, from: string, to: string): SourceSpec | { refused: string } {
  const name = to.trim();
  if (!name) return { refused: "Give the computed column a name." };
  if (name === from) return spec;
  if (spec.fields.some((f) => f.name === name) || Object.hasOwn(spec.derive ?? {}, name)) return { refused: `A column is already named ${name}. Use a different name.` };
  const move = (r: ValueRef): ValueRef => {
    if ("field" in r) return r.field === from ? { ...r, field: name } : r;
    const b = computeSteps(r.cel);
    return b && b.source === from ? { ...r, cel: computeCel(name, b.steps) } : r;
  };
  const mapping = Object.fromEntries(Object.entries(spec.mapping).map(([k, r]) => {
    if (k === "attrs") return [k, Object.fromEntries(Object.entries(r as Record<string, ValueRef>).map(([n, v]) => [n, move(v)]))];
    return [k, r && typeof r === "object" ? move(r as ValueRef) : r];
  })) as Mapping;
  return { ...spec, mapping, derive: Object.fromEntries(Object.entries(spec.derive).map(([k, v]) => [k === from ? name : k, v])) };
}
