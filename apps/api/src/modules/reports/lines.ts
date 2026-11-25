// A report's rendered rows laid out as the file's lines (spec 2026-11-26 "Spec v2"): group lines and subtotals when
// the design groups, then the total line; and the sheet: headers, layouts and the sections, each optional, with their
// tokens filled. Every writer (CSV, Text, Excel, PDF) writes the same lines, so one design looks alike in each.
import type { ColumnLayout, ReportSpec } from "@starterkit/shared/contracts/reports";
import { formatCell } from "@starterkit/shared/report-format";
import type { DataRow, Rendered } from "./cells";

export type Mark = "red" | "bold" | null;
/** `values[i]`: the cell as a number when it is one (Excel writes it as a number), else its text. */
export type Line = { kind: "row" | "group" | "subtotal" | "total"; level: number; cells: string[]; values: (string | number)[]; text: boolean[]; marks: Mark[] };
export type RowIn = Rendered & { data: DataRow };
export type SheetCtx = {
  recon: string; template: string; from: string; to: string; madeAt: string; final: boolean; masking: "masked" | "full";
  first: DataRow | null; count: number; sums: Record<string, number>;
};
export type Sheet = {
  headers: string[]; layouts: ColumnLayout[]; numeric: boolean[]; columnHeaders: boolean;
  title: string | null; header: { label: string; value: string }[] | null; footer: { text: string; stamp: string | null; pageNumbers: boolean } | null;
  groupLines: boolean; delimiter: string; quoteAll: boolean; eol: string; ascii: boolean;
};

/** `{recon}`, `{template}`, `{from}`, `{to}`, `{date}` (the date or from_to), `{made_at}`; another brace stays its word. */
export function fillTokens(text: string, c: Pick<SheetCtx, "recon" | "template" | "from" | "to" | "madeAt">): string {
  const t: Record<string, string> = { recon: c.recon, template: c.template, from: c.from, to: c.to, date: c.from === c.to ? c.from : `${c.from} – ${c.to}`, made_at: c.madeAt.slice(0, 16).replace("T", " ") };
  return text.replace(/\{([a-z_]+)\}/g, (_, k: string) => t[k] ?? k);
}

/** The file's frame: headers and layouts, and each section (null when off). */
/**
 * `hidden`: customer-data fields of a masked file: a header sum over one is left blank (a sum of accounts, or of amounts
 * a recon marks as customer data, would give them away).
 */
export function sheetOf(spec: ReportSpec, c: SheetCtx, mask: (ref: string, v: string) => string = (_, v) => v, hidden: Set<string> = new Set()): Sheet {
  const s = spec.sections;
  const value = (v: ReportSpec["sections"]["header"]["lines"][number]["value"]): string => {
    if (v.kind === "text") return fillTokens(v.text, c);
    if (v.kind === "count") return String(c.count);
    if (v.kind === "sum") {
      if (hidden.has(v.ref)) return "";
      // in the format of a column showing that field, else two decimals
      const col = spec.columns.find((x) => x.content.kind === "field" && x.content.ref === v.ref && x.format.kind === "number");
      return formatCell(c.sums[v.ref] ?? 0, col?.format ?? { kind: "number", decimals: 2, thousands: "none", negative: "minus", prefix: "", suffix: "" });
    }
    const raw = c.first?.values[v.ref];
    return raw === null || raw === undefined ? "" : mask(v.ref, String(raw));
  };
  const stamp = `${c.final ? "Final" : "Not final"} · ${c.masking === "masked" ? "Masked customer data" : "Full customer data"}`;
  const o = spec.output;
  return {
    headers: spec.columns.map((col) => col.header), layouts: spec.columns.map((col) => col.layout), numeric: spec.columns.map((col) => col.format.kind === "number"),
    columnHeaders: s.columnHeaders,
    title: s.title.on ? fillTokens(s.title.text, c) : null,
    header: s.header.on && s.header.lines.length ? s.header.lines.map((l) => ({ label: l.label, value: value(l.value) })) : null,
    footer: s.footer.on ? { text: fillTokens(s.footer.text, c), stamp: s.footer.stamp ? stamp : null, pageNumbers: s.footer.pageNumbers } : null,
    groupLines: o.groupLines, delimiter: o.csv.delimiter, quoteAll: o.csv.quote === "all", eol: o.lineEnding === "crlf" ? "\r\n" : "\n", ascii: o.encoding === "ascii",
  };
}

export const rowLine = (r: Rendered): Line => ({
  kind: "row", level: 0, cells: r.cells, marks: r.marks,
  values: r.cells.map((t, i) => (typeof r.raw[i] === "number" && t !== "" && !t.startsWith("·") ? (r.raw[i] as number) : t)),
  text: r.raw.map((v) => typeof v !== "number"),
});

/** Running totals of rows as they pass (a streamed file's total line), and the line they make. */
export function totaller(spec: ReportSpec, hidden: Set<string> = new Set()) {
  const sums = spec.columns.map(() => 0);
  let n = 0;
  return {
    add(r: Rendered) { n++; r.raw.forEach((v, i) => { if (typeof v === "number") sums[i]! += v; }); },
    line: (kind: "subtotal" | "total" = "total", level = 0) => totalsLine(spec, sums, n, kind, level, hidden),
  };
}

/** The totals line of `rows` (`label` in the first column when it holds no total). */
function totalLine(spec: ReportSpec, rows: RowIn[], kind: "subtotal" | "total", level: number, hidden: Set<string>): Line {
  const t = totaller(spec, hidden);
  for (const r of rows) t.add(r);
  return t.line(kind, level);
}

/** `hidden`: ids of customer-data columns of a masked file: their sums stay blank (a count is kept). */
function totalsLine(spec: ReportSpec, sums: number[], n: number, kind: "subtotal" | "total", level: number, hidden: Set<string> = new Set()): Line {
  const values = spec.columns.map((col, i): string | number => {
    const fn = hidden.has(col.id) && spec.totals.columns[col.id] === "sum" ? undefined : spec.totals.columns[col.id];
    return fn === "count" ? n : fn === "sum" ? sums[i]! : "";
  });
  const cells = spec.columns.map((col, i) => (typeof values[i] === "number" ? (spec.totals.columns[col.id] === "sum" ? formatCell(values[i] as number, col.format) : String(values[i])) : ""));
  if (cells.length && cells[0] === "") { cells[0] = kind === "total" ? "Total" : "Subtotal"; values[0] = cells[0]; }
  return { kind, level, cells, values, text: values.map((v) => typeof v !== "number"), marks: cells.map(() => "bold" as const) };
}

/**
 * The lines of `rows`: grouped by `spec.groups` (sorted by the real value, labelled with `label`, e.g. masked) with a
 * group line and, when totals per group are on, a subtotal each; then the total line when totals are on.
 */
export function linesOf(spec: ReportSpec, rows: RowIn[], label: (ref: string, v: string) => string = (_, v) => v, hidden: Set<string> = new Set()): Line[] {
  const out: Line[] = [];
  const blank = (text: string, level: number): Line => ({ kind: "group", level, cells: spec.columns.map((_, i) => (i === 0 ? `${"  ".repeat(level)}${text}` : "")), values: spec.columns.map((_, i) => (i === 0 ? `${"  ".repeat(level)}${text}` : "")), text: spec.columns.map(() => true), marks: spec.columns.map(() => "bold" as const) });
  // summary only: a group's line holds its fields' values (masked as the file is) and its totals, no detail rows
  const summary = (part: RowIn[], keys: string[]): Line => {
    const t = totalsLine(spec, part.reduce((sums, r) => { r.raw.forEach((v, i) => { if (typeof v === "number") sums[i]! += v; }); return sums; }, spec.columns.map(() => 0)), part.length, "subtotal", 0, hidden);
    const cells = spec.columns.map((c, i) => {
      const g = c.content.kind === "field" ? spec.groups.indexOf(c.content.ref) : -1;
      if (g < 0 || g >= keys.length) return spec.totals.columns[c.id] ? t.cells[i]! : "";
      return keys[g] === "" ? "(empty)" : label(spec.groups[g]!, keys[g]!);
    });
    const values = cells.map((x, i) => (spec.totals.columns[spec.columns[i]!.id] && typeof t.values[i] === "number" && x === t.cells[i] ? t.values[i]! : x));
    return { kind: "row", level: 0, cells, values, text: values.map((v) => typeof v !== "number"), marks: cells.map(() => null) };
  };
  const walk = (part: RowIn[], level: number, keys: string[] = []) => {
    if (spec.summaryOnly && level === spec.groups.length) { out.push(summary(part, keys)); return; }
    if (level === spec.groups.length) { for (const r of part) out.push(rowLine(r)); return; }
    const ref = spec.groups[level]!;
    const key = (r: RowIn) => String(r.data.values[ref] ?? "");
    const by = Map.groupBy(part, key);
    for (const k of [...by.keys()].sort((a, b) => a.localeCompare(b))) {
      const g = by.get(k)!;
      if (!spec.summaryOnly) out.push(blank(k === "" ? "(empty)" : label(ref, k), level));
      walk(g, level + 1, [...keys, k]);
      if (!spec.summaryOnly && spec.totals.on && spec.totals.perGroup) out.push(totalLine(spec, g, "subtotal", level, hidden));
    }
  };
  walk(rows, 0);
  if (spec.totals.on && spec.columns.length) out.push(totalLine(spec, rows, "total", 0, hidden));
  return out;
}

/** Whether a writer shows `line`: rows and the total always; group and subtotal lines in CSV/Text only when asked. */
export const shown = (l: Line, sheet: Sheet, flat: boolean) => l.kind === "row" || l.kind === "total" || !flat || sheet.groupLines;

/** ASCII for a file asked as such: masking dots become *, accents are dropped (é → e), the rest that isn't ASCII goes. */
export const toAscii = (s: string) => s.replace(/·/g, "*").normalize("NFKD").replace(/[^\x20-\x7e\t]/g, "");
