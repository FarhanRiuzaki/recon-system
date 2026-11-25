// A data row as the report's cells (spec 2026-11-26 "Spec v2"): each column's content (field with its fallback,
// formula, fixed text, row number), masked when it holds customer data (a formula naming a customer field is customer
// data), then formatted. The worker's file and the preview both render through here (preview = file).
import type { ReportColumn, ReportSpec } from "@starterkit/shared/contracts/reports";
import { formatCell } from "@starterkit/shared/report-format";
import { compileFormula, type Formula } from "./formula";
import { maskValue } from "./mask";

/** A row of the dataset: refs (`a:ext_ref`, `recon:status`, `recap:matched` …) to values, numbers in major units. */
export type DataRow = { date: string; values: Record<string, string | number | null> };
export type Problem = { columnId: string; message: string };
export type Rendered = { cells: string[]; raw: (string | number | null)[]; marks: ("red" | "bold" | null)[]; problems?: Problem[] };
export type Renderer = { formulas: Map<string, Formula>; customer: Set<string>; masked: boolean };

/** Ids of the columns whose cells are customer data: a customer field, or a formula naming one. */
export function customerOf(spec: ReportSpec, base: Set<string>, formulas: Map<string, Formula>): Set<string> {
  const out = new Set<string>();
  for (const c of spec.columns) {
    const k = c.content;
    if (k.kind === "field" && (base.has(k.ref) || (k.fallback && base.has(k.fallback)))) out.add(c.id);
    const f = formulas.get(c.id);
    if (f?.ok && f.refs.some((r) => base.has(r))) out.add(c.id);
  }
  return out;
}

/** Compiled once per file: the formulas, which columns are customer data, whether to mask (`forceMask`: the preview). */
export function rendererOf(spec: ReportSpec, customerRefs: Set<string>, forceMask = false): Renderer {
  const formulas = new Map(spec.columns.flatMap((c) => (c.content.kind === "formula" ? [[c.id, compileFormula(c.content.cel)] as const] : [])));
  return { formulas, customer: customerOf(spec, customerRefs, formulas), masked: forceMask || spec.output.masking === "masked" };
}

function valueOf(c: ReportColumn, row: DataRow, index: number, r: Renderer): { v: string | number | null; problem?: string } {
  const k = c.content;
  switch (k.kind) {
    case "rownum": return { v: index + 1 };
    case "text": return { v: k.text };
    case "field": {
      const v = row.values[k.ref];
      return { v: (v === null || v === undefined || v === "") && k.fallback ? (row.values[k.fallback] ?? null) : (v ?? null) };
    }
    case "formula": {
      const f = r.formulas.get(c.id)!;
      if (!f.ok) return { v: null, problem: `${c.header || "A column"}: ${f.error}` };
      const out = f.run(row.values);
      if (!out.ok) return { v: null, problem: `${c.header || "A column"}: ${out.reason}` };
      const v = out.value;
      return { v: typeof v === "bigint" ? Number(v) : typeof v === "number" || typeof v === "string" ? v : v === null || v === undefined ? null : String(v) };
    }
  }
}

function markOf(c: ReportColumn, v: string | number | null): "red" | "bold" | null {
  const h = c.highlight;
  if (!h) return null;
  const n = typeof v === "number" ? v : Number(v);
  const hit = h.when === "empty" ? v === null || v === "" : h.when === "equals" ? String(v ?? "") === (h.value ?? "")
    : h.when === "negative" ? Number.isFinite(n) && n < 0 : v !== null && v !== "" && Number.isFinite(n) && n !== 0;
  return hit ? h.style : null;
}

/** Row `index` (0-based, of the file or of its group) as cells. */
export function renderRow(spec: ReportSpec, row: DataRow, index: number, r: Renderer): Rendered {
  const out: Rendered = { cells: [], raw: [], marks: [] };
  for (const c of spec.columns) {
    const { v, problem } = valueOf(c, row, index, r);
    if (problem) {
      out.cells.push("#ERR"); out.raw.push(null); out.marks.push("red");
      (out.problems ??= []).push({ columnId: c.id, message: problem });
      continue;
    }
    const text = v === null ? "" : r.masked && r.customer.has(c.id) ? maskValue(String(v)) : formatCell(v, c.format);
    out.cells.push(text); out.raw.push(v); out.marks.push(markOf(c, v));
  }
  return out;
}
