// The report designer's edits (spec 2026-11-26 "Designer UX"), each a pure function of the design: columns placed,
// moved, replaced and set; groups; the sections each on or off ("Data only" turns all off); the output format; the
// undo/redo history and the keyboard's commands. The screen only wires them to drags, clicks and keys.
import type { ColumnFormat, ReportColumn, ReportFieldDto, ReportSpec } from "@starterkit/shared/contracts/reports";
import { REPORT_GROUPS_MAX, type ReportFormat } from "@starterkit/shared/reports";

export type SectionKey = "title" | "header" | "columnHeaders" | "totals" | "footer";
type FieldLike = Pick<ReportFieldDto, "ref" | "label"> & { type: string };

/** The next free column id (c1, c2 … in base 36). */
export function newColumnId(spec: ReportSpec, taken: string[] = []): string {
  const used = [...spec.columns.map((c) => c.id), ...taken].map((id) => parseInt(id.slice(1), 36)).filter(Number.isFinite);
  return `c${((used.length ? Math.max(...used) : 0) + 1).toString(36)}`;
}

const formatFor = (f: FieldLike): ColumnFormat => (f.type === "number"
  ? { kind: "number", decimals: /amount/.test(f.ref) ? 2 : 0, thousands: ".", negative: "minus", prefix: "", suffix: "" }
  : f.type === "date" ? { kind: "date", pattern: "dd/MM/yyyy" } : { kind: "auto" });

/** A new column showing field `f`: its label as header, a format by its type, a width that fits the header. */
export function columnOfField(spec: ReportSpec, f: FieldLike): ReportColumn {
  return {
    id: newColumnId(spec), header: f.label, content: { kind: "field", ref: f.ref }, format: formatFor(f),
    layout: { align: f.type === "number" ? "r" : "l", width: Math.max(10, Math.min(40, f.label.length + 2)), pad: " " },
  };
}

/** A new "Build your own" column: a formula (a difference to start from), fixed text, or the row number. */
export function specialColumn(spec: ReportSpec, kind: "formula" | "text" | "rownum"): ReportColumn {
  const id = newColumnId(spec);
  if (kind === "formula") return { id, header: "Formula", content: { kind: "formula", cel: "a.amount_minor - b.amount_minor" }, format: formatFor({ ref: "amount", label: "", type: "number" }), layout: { align: "r", width: 14, pad: " " } };
  if (kind === "text") return { id, header: "Text", content: { kind: "text", text: "" }, format: { kind: "auto" }, layout: { align: "l", width: 10, pad: " " } };
  return { id, header: "No", content: { kind: "rownum" }, format: { kind: "auto" }, layout: { align: "r", width: 6, pad: " " } };
}

const withColumns = (spec: ReportSpec, columns: ReportColumn[]): ReportSpec => ({ ...spec, columns });
const at = (spec: ReportSpec, id: string) => spec.columns.findIndex((c) => c.id === id);

export const addColumn = (spec: ReportSpec, c: ReportColumn, index = spec.columns.length): ReportSpec =>
  withColumns(spec, [...spec.columns.slice(0, index), c, ...spec.columns.slice(index)]);

/** Column `id` moved to before the column now at `to` (spec.columns.length = the end). */
export function moveColumn(spec: ReportSpec, id: string, to: number): ReportSpec {
  const from = at(spec, id);
  if (from < 0) return spec;
  const rest = spec.columns.filter((c) => c.id !== id);
  const i = to > from ? to - 1 : to;
  return withColumns(spec, [...rest.slice(0, i), spec.columns[from]!, ...rest.slice(i)]);
}

/** Column `id` now shows field `f` (dropped on it): content, header and format follow the field. */
export function replaceField(spec: ReportSpec, id: string, f: FieldLike): ReportSpec {
  return withColumns(spec, spec.columns.map((c) => (c.id === id ? { ...c, header: f.label, content: { kind: "field", ref: f.ref }, format: formatFor(f), layout: { ...c.layout, align: f.type === "number" ? "r" : "l" } } : c)));
}

export function removeColumn(spec: ReportSpec, id: string): ReportSpec {
  const { [id]: _gone, ...totals } = spec.totals.columns;
  return { ...withColumns(spec, spec.columns.filter((c) => c.id !== id)), totals: { ...spec.totals, columns: totals } };
}

export function duplicateColumn(spec: ReportSpec, id: string): ReportSpec {
  const i = at(spec, id);
  if (i < 0) return spec;
  const c = spec.columns[i]!;
  return addColumn(spec, { ...structuredClone(c), id: newColumnId(spec), header: `${c.header} (copy)` }, i + 1);
}

export const patchColumn = (spec: ReportSpec, id: string, patch: Partial<ReportColumn>): ReportSpec =>
  withColumns(spec, spec.columns.map((c) => (c.id === id ? { ...c, ...patch } : c)));

export const addGroup = (spec: ReportSpec, ref: string): ReportSpec =>
  spec.groups.includes(ref) || spec.groups.length >= REPORT_GROUPS_MAX ? spec : { ...spec, groups: [...spec.groups, ref] };
export const removeGroup = (spec: ReportSpec, i: number): ReportSpec => ({ ...spec, groups: spec.groups.filter((_, k) => k !== i) });

/** Whether section `k` is in the file. */
export function sectionOn(spec: ReportSpec, k: SectionKey): boolean {
  if (k === "columnHeaders") return spec.sections.columnHeaders;
  if (k === "totals") return spec.totals.on;
  return spec.sections[k].on;
}

export function toggleSection(spec: ReportSpec, k: SectionKey): ReportSpec {
  const s = spec.sections;
  if (k === "totals") return { ...spec, totals: { ...spec.totals, on: !spec.totals.on } };
  if (k === "columnHeaders") return { ...spec, sections: { ...s, columnHeaders: !s.columnHeaders } };
  return { ...spec, sections: { ...s, [k]: { ...s[k], on: !s[k].on } } };
}

/** Data only: just the rows, nothing above or below them. */
export function dataOnly(spec: ReportSpec): ReportSpec {
  const s = spec.sections;
  return { ...spec, totals: { ...spec.totals, on: false }, sections: { title: { ...s.title, on: false }, header: { ...s.header, on: false }, columnHeaders: false, footer: { ...s.footer, on: false } } };
}

export const setFormat = (spec: ReportSpec, format: ReportFormat): ReportSpec => ({ ...spec, output: { ...spec.output, format } });

/** Why the design can't be sent yet (the API says the same; formulas are checked there). */
export const sendProblem = (spec: ReportSpec): string | null =>
  !spec.columns.length ? "Add at least one column." : spec.summaryOnly && !spec.groups.length ? "Group by at least one field for a summary." : null;

/** Summary only on or off; turned on, each number column that isn't a group's field gets a sum (unless it has a total). */
export function toggleSummary(spec: ReportSpec): ReportSpec {
  if (spec.summaryOnly) return { ...spec, summaryOnly: false };
  const columns = { ...spec.totals.columns };
  for (const c of spec.columns) {
    const grouped = c.content.kind === "field" && spec.groups.includes(c.content.ref);
    if (!grouped && c.format.kind === "number" && !columns[c.id]) columns[c.id] = "sum";
  }
  return { ...spec, summaryOnly: true, totals: { ...spec.totals, on: true, columns } };
}

/** Undo and redo over whole designs (at most 80 steps back). */
export type History = { past: ReportSpec[]; now: ReportSpec; future: ReportSpec[] };
export const history = {
  start: (now: ReportSpec): History => ({ past: [], now, future: [] }),
  push: (h: History, next: ReportSpec): History => (next === h.now ? h : { past: [...h.past, h.now].slice(-80), now: next, future: [] }),
  undo: (h: History): History => (h.past.length ? { past: h.past.slice(0, -1), now: h.past.at(-1)!, future: [h.now, ...h.future] } : h),
  redo: (h: History): History => (h.future.length ? { past: [...h.past, h.now], now: h.future[0]!, future: h.future.slice(1) } : h),
};

/** The designer's keys: Ctrl/⌘+Z, Ctrl/⌘+Shift+Z, Delete/Backspace on the selected column, Alt+←/→ to move it. Not while typing. */
export function keyAction(e: { key: string; ctrl: boolean; shift: boolean; alt: boolean; typing: boolean; selected: boolean }): "undo" | "redo" | "remove" | "left" | "right" | null {
  if (e.typing) return null;
  if (e.ctrl && e.key.toLowerCase() === "z") return e.shift ? "redo" : "undo";
  if (!e.selected) return null;
  if (e.key === "Delete" || e.key === "Backspace") return "remove";
  if (e.alt && e.key === "ArrowLeft") return "left";
  if (e.alt && e.key === "ArrowRight") return "right";
  return null;
}
