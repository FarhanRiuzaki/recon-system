// How a sample file is read (the file reader, DEC-058): a proposed `format` with its column names, a preview of the
// rows with the role each gets, and how sure the call is. Text: encoding (byte order mark, else valid UTF-8, else
// Windows-1252), then delimited (the delimiter whose cell count holds for the body) or fixed-length (lines of one
// length, cut where spaces line up or digits meet letters), title lines above, total lines below, a header row, and
// record types (a short code in the first cell or first character with its own cell count). Excel: the sheet with the
// most rows, read like text rows. PDF, ZIP, images, XML, JSON and binary files are named and refused. Stores nothing.
import type { DetectDto, FileFormat, RecordTypes } from "@starterkit/shared/contracts/sources";
import { parse as parseCsv } from "csv-parse/sync";
import { read as readXlsx, utils } from "xlsx";
import { bomOf } from "./decode";
import { cellText } from "./excel";

export type Sample = { head: Uint8Array; tail: Uint8Array | null; size: number; name: string };
export type DetectOutcome = Extract<DetectDto, { supported: true }> extends infer T ? Omit<Extract<T, { supported: true }>, "sampleId"> | Extract<DetectDto, { supported: false }> : never;
type Row = { line: number; cells: string[] };
type Role = DetectDto extends infer D ? D extends { rows: (infer R)[] } ? R extends { role: infer X } ? X : never : never : never;

const DELIMITERS = [",", ";", "|", "\t"];
const TOTAL = /^\s*(grand\s*total|sub\s*total|subtotal|total|jumlah)\b/i;
const NUMBER = /^[-+]?(\d[\d.,]*|\.\d+)$/;
const DATE = /^(\d{4}-\d{2}-\d{2}([ T].*)?|\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{8})$/;
const PREVIEW = 50;
const pad2 = (n: number) => String(n).padStart(2, "0");
const names = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix}_${pad2(i + 1)}`);
const valueLike = (s: string) => NUMBER.test(s.trim()) || DATE.test(s.trim());

const ascii = (b: Uint8Array, n: number) => String.fromCharCode(...b.subarray(0, n));
/** What the first bytes are: text, an Excel workbook, or a type it can't read (named for the message). */
export function sniffKind(head: Uint8Array): "text" | "xlsx" | "xls" | { unsupported: string } {
  if (ascii(head, 5) === "%PDF-") return { unsupported: "PDF" };
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    return Buffer.from(head.subarray(0, Math.min(head.length, 64 * 1024))).toString("latin1").includes("xl/") ? "xlsx" : { unsupported: "ZIP" };
  }
  if ([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].every((b, i) => head[i] === b)) return "xls";
  if ((head[0] === 0x89 && ascii(head.subarray(1), 3) === "PNG") || (head[0] === 0xff && head[1] === 0xd8) || ascii(head, 4) === "GIF8") return { unsupported: "Image" };
  if (bomOf(head)?.encoding.startsWith("utf-16")) return "text";
  const probe = head.subarray(0, 4096);
  const control = probe.filter((b) => b < 9 || (b > 13 && b < 32)).length;
  if (probe.length && control / probe.length > 0.05) return { unsupported: "Binary" };
  const start = new TextDecoder().decode(probe).replace(/^﻿/, "").trimStart();
  if (start.startsWith("<")) return { unsupported: "XML" };
  if (/^[{[]\s*["{[]/.test(start)) return { unsupported: "JSON" };
  return "text";
}

/** The encoding of a text sample, and its text. */
function decodeSample(b: Uint8Array): { encoding: FileFormat extends infer F ? F extends { encoding: infer E } ? E : never : never; text: string } {
  const bom = bomOf(b);
  if (bom) return { encoding: bom.encoding === "utf-8" ? "utf-8" : "utf-16le", text: new TextDecoder(bom.encoding as "utf-8").decode(b.subarray(bom.length)) };
  try { return { encoding: "utf-8", text: new TextDecoder("utf-8", { fatal: true }).decode(b) }; } catch { return { encoding: "windows-1252", text: new TextDecoder("windows-1252").decode(b) }; }
}

/** The non-empty lines of the sample's head (its cut last line dropped when the file goes on) and tail (its cut first line dropped). */
function sampleLines(s: Sample, text: string, tailText: string | null): { head: string[]; tail: string[] } {
  const split = (t: string) => t.split("\n").map((l) => l.replace(/\r$/, ""));
  const head = split(text);
  if (s.size > s.head.length) head.pop();
  const tail = tailText === null ? [] : split(tailText).slice(1);
  return { head: head.filter((l) => l.length), tail: tail.filter((l) => l.length) };
}

const mode = (xs: number[]) => { const c = new Map<number, number>(); for (const x of xs) c.set(x, (c.get(x) ?? 0) + 1); return [...c].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 0; };

/** Leading rows that don't fit the body (at most 20): titles above the header. */
const titleRows = (counts: number[], body: number) => { let k = 0; while (k < Math.min(20, counts.length - 1) && counts[k] !== body) k++; return k; };

/** Trailing rows that are totals or don't fit the body (at most 10). */
function footerRows(rows: Row[], body: number): number {
  let k = 0;
  while (k < Math.min(10, rows.length - 1)) {
    const r = rows[rows.length - 1 - k]!;
    if (r.cells.length === body && !TOTAL.test(r.cells[0] ?? "")) break;
    k++;
  }
  return k;
}

/** Whether the first body row names the columns: words where the rows below hold numbers or dates, all distinct. */
function headerScore(rows: Row[]): number {
  const [h, ...below] = rows;
  if (!h || !below.length) return 0;
  const cells = h.cells.map((c) => c.trim());
  if (new Set(cells).size !== cells.length || cells.some((c) => !c)) return 0;
  const words = cells.filter((c) => !valueLike(c)).length / cells.length;
  const look = below.slice(0, 20);
  const contrast = cells.some((c, i) => !valueLike(c) && look.filter((r) => valueLike(r.cells[i] ?? "")).length >= Math.ceil(look.length * 0.6));
  // a close call: some words over numbers, but the row is half values itself
  return contrast && words >= 0.8 ? 1 : contrast && words >= 0.5 ? 0.4 : 0;
}

/** Record types told apart by the first cell (or `prefix` characters): a few short codes, each with one cell count. */
function recordTypes(rows: Row[], code: (r: Row) => string, count: (r: Row) => number): { types: RecordTypes["types"]; roles: Map<string, Role> } | null {
  if (rows.length < 3) return null;
  const by = new Map<string, number[]>();
  for (const r of rows) { const c = code(r); if (!c || c.length > 3) return null; by.set(c, [...(by.get(c) ?? []), count(r)]); }
  if (by.size < 2 || by.size > 6) return null;
  if ([...by.values()].some((cs) => new Set(cs).size !== 1)) return null;
  // a type repeats: only a trailer (the last line's code) may stand alone; one-off first cells are data, not codes
  const lastCode = code(rows.at(-1)!);
  if ([...by.entries()].some(([c, cs]) => cs.length < 2 && c !== lastCode)) return null;
  const order = [...by.entries()].sort((a, b) => b[1].length - a[1].length);
  const detail = order[0]![0];
  const last = lastCode;
  const before = rows.findIndex((r, i) => i > 0 && code(r) === detail && code(rows[i - 1]!) !== detail);
  const header = before > 0 ? code(rows[before - 1]!) : null;
  const roles = new Map<string, Role>();
  const types = order.map(([c, cs]): RecordTypes["types"][number] => {
    const role = c === detail ? "detail" : c === header && c !== last ? "header" : "skip";
    roles.set(c, role === "detail" ? "detail" : role === "header" ? "record_header" : c === last ? "trailer" : "skipped");
    return { code: c, role, count: cs[0]! };
  });
  return { types, roles };
}

/** A grid of rows (a delimited sample or a sheet) read as a table: title rows, header, footer, record types. */
type Grid = { rt: { types: RecordTypes["types"]; roles: Map<string, Role> } | null; top: number; bottom: number; header: boolean; close: boolean; body: number; share: number };
function shapeGrid(rows: Row[], tail: Row[]): Grid {
  const counts = rows.map((r) => r.cells.length);
  const rt = recordTypes(rows, (r) => (r.cells[0] ?? "").trim(), (r) => r.cells.length);
  if (rt) return { rt, top: 0, bottom: 0, header: false, close: false, body: 0, share: 1 };
  const body = mode(counts.filter((c) => c > 1));
  const top = titleRows(counts, body);
  const rest = rows.slice(top);
  const share = rest.length ? rest.filter((r) => r.cells.length === body).length / rest.length : 0;
  const end = tail.length ? tail : rest;
  const bottom = footerRows(end, body);
  const header = headerScore(rest.slice(0, Math.max(1, rest.length - (tail.length ? 0 : bottom))));
  return { rt: null, top, bottom, header: header >= 1, close: header > 0 && header < 1, body, share };
}

/** The preview rows of a grid under its shape. */
function gridRoles(rows: Row[], tail: Row[], g: Grid): { line: number; role: Role; cells: string[] }[] {
  const out: { line: number; role: Role; cells: string[] }[] = [];
  const endRows = tail.length ? [] : rows.slice(rows.length - g.bottom);
  const main = tail.length ? rows : rows.slice(0, rows.length - g.bottom);
  main.slice(0, PREVIEW).forEach((r, i) => {
    let role: Role;
    if (g.rt) role = g.rt.roles.get((r.cells[0] ?? "").trim()) ?? "quarantined";
    else if (i < g.top) role = "skipped";
    else if (g.header && i === g.top) role = "header";
    else role = r.cells.length === g.body ? "detail" : "quarantined";
    out.push({ line: r.line, role, cells: r.cells });
  });
  for (const r of (tail.length ? tail.slice(tail.length - g.bottom) : endRows)) out.push({ line: r.line, role: "skipped", cells: r.cells });
  return out;
}

const skips = (top: number, bottom: number) => ({ ...(top ? { skip_top: top } : {}), ...(bottom ? { skip_bottom: bottom } : {}) });
const columnsOf = (g: Grid, rows: Row[]) => g.rt
  ? [...names("hdr", g.rt.types.find((t) => t.role === "header")?.count ?? 0), ...names("col", g.rt.types.find((t) => t.role === "detail")!.count)]
  : g.header ? rows[g.top]!.cells.map((c, i) => c.trim() || `col_${pad2(i + 1)}`) : names("col", g.body ?? 0);

/** Fixed-length positions: a column starts after a run of spaces every line has, or where digits meet letters in nearly every line. */
function fixedColumns(lines: string[]): { start: number; length: number }[] {
  const width = Math.max(...lines.map((l) => l.length));
  const at = (l: string, i: number) => l[i] ?? " ";
  const cls = (ch: string) => (/\d/.test(ch) ? "d" : /\s/.test(ch) ? "s" : "a");
  const starts = [0];
  for (let i = 1; i < width; i++) {
    const afterSpace = lines.every((l) => at(l, i - 1) === " ") && lines.some((l) => at(l, i) !== " ");
    const shift = lines.filter((l) => { const a = cls(at(l, i - 1)), b = cls(at(l, i)); return a !== "s" && b !== "s" && a !== b; }).length >= lines.length * 0.9;
    if (afterSpace || shift) starts.push(i);
  }
  return starts.map((s, k) => ({ start: s + 1, length: (starts[k + 1] ?? width) - s }));
}

function detectText(s: Sample) {
  const { encoding, text } = decodeSample(s.head);
  const tailText = s.tail ? decodeSample(s.tail).text : null;
  const lines = sampleLines(s, text, tailText);
  let best: { delimiter: string; rows: Row[]; tail: Row[]; g: Grid } | null = null;
  for (const delimiter of DELIMITERS) {
    const grid = (t: string[], from: number) => (parseCsv(t.join("\n"), { delimiter, relax_column_count: true, relax_quotes: true, skip_empty_lines: true, info: true }) as unknown as { record: string[]; info: { lines: number } }[])
      .map((x) => ({ line: from ? 0 : x.info.lines, cells: x.record }));
    let rows: Row[], tail: Row[];
    try { rows = grid(lines.head, 0); tail = grid(lines.tail, 1); } catch { continue; }
    if (!rows.length || mode(rows.map((r) => r.cells.length)) < 2 && !recordTypes(rows, (r) => (r.cells[0] ?? "").trim(), (r) => r.cells.length)) continue;
    const g = shapeGrid(rows, tail);
    if (!best || g.share > best.g.share || (g.share === best.g.share && (g.body ?? 0) > (best.g.body ?? 0))) best = { delimiter, rows, tail, g };
  }
  if (best && best.g.share >= 0.9) {
    const { delimiter, rows, tail, g } = best;
    const format: FileFormat = { kind: "delimited", delimiter, quote: '"', header: g.header, encoding, ...skips(g.top, g.bottom), ...(g.rt ? { records: { marker: { kind: "column" as const, index: 0 }, types: g.rt.types } } : {}) };
    const low = g.share < 0.98 || g.close;
    return { supported: true as const, fileName: s.name, format, columns: columnsOf(g, rows), confidence: low ? "low" as const : "high" as const, notes: low ? ["Check these settings: the file was hard to read."] : [], rows: gridRoles(rows, tail, g) };
  }
  // fixed-length: most lines one length
  const all = lines.head;
  const len = mode(all.map((l) => l.length));
  const same = all.filter((l) => l.length === len);
  if (all.length >= 2 && same.length / all.length >= 0.8 && len > 1) {
    const columns = fixedColumns(same);
    if (columns.length >= 2) {
      const top = titleRows(all.map((l) => l.length), len);
      const bottom = footerRows(all.map((l, i) => ({ line: i + 1, cells: l.length === len ? Array(columns.length).fill("x") : [l] })), columns.length);
      const format: FileFormat = { kind: "fixed_width", encoding, header: false, columns, ...skips(top, bottom) };
      const rows = all.slice(0, PREVIEW).map((l, i) => ({ line: i + 1, role: (i < top || i >= all.length - bottom ? "skipped" : l.length === len ? "detail" : "quarantined") as Role, cells: columns.map((c) => l.slice(c.start - 1, c.start - 1 + c.length)) }));
      const low = same.length / all.length < 0.98;
      return { supported: true as const, fileName: s.name, format, columns: names("col", columns.length), confidence: low ? "low" as const : "high" as const, notes: low ? ["Check these settings: the file was hard to read."] : [], rows };
    }
  }
  const guess: FileFormat = { kind: "delimited", delimiter: best?.delimiter ?? ",", quote: '"', header: false, encoding };
  return { supported: true as const, fileName: s.name, format: guess, columns: names("col", best ? mode(best.rows.map((r) => r.cells.length)) || 1 : 1), confidence: "none" as const,
    notes: ["This file can't be read automatically yet. Set how it is read below."], rows: lines.head.slice(0, PREVIEW).map((l, i) => ({ line: i + 1, role: "detail" as Role, cells: [l] })) };
}

function detectExcel(s: Sample) {
  const wb = readXlsx(s.head, { type: "array", cellNF: true });
  const sheets = wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name]!;
    const rows: Row[] = [];
    if (ws["!ref"]) {
      const range = utils.decode_range(ws["!ref"]);
      for (let r = range.s.r; r <= range.e.r; r++) {
        const cells: string[] = [];
        for (let c = range.s.c; c <= range.e.c; c++) cells.push(cellText(ws[utils.encode_cell({ r, c })]));
        while (cells.length && cells.at(-1) === "") cells.pop();
        if (cells.length) rows.push({ line: r + 1, cells });
      }
    }
    return { name, rows };
  }).sort((a, b) => b.rows.length - a.rows.length);
  const pick = sheets[0];
  if (!pick?.rows.length) return { supported: true as const, fileName: s.name, format: { kind: "excel", sheet: { kind: "first" }, header: false } as FileFormat, columns: ["col_01"], confidence: "none" as const, notes: ["The workbook has no rows to read."], rows: [] };
  const g = shapeGrid(pick.rows, []);
  const format: FileFormat = { kind: "excel", sheet: wb.SheetNames.length > 1 ? { kind: "name", name: pick.name } : { kind: "first" }, header: g.header, ...skips(g.top, g.bottom) };
  const low = g.share < 0.98 || !!g.close;
  return { supported: true as const, fileName: s.name, format, columns: columnsOf({ ...g, rt: null }, pick.rows), confidence: low ? "low" as const : "high" as const,
    notes: low ? ["Check these settings: the file was hard to read."] : [], rows: gridRoles(pick.rows, [], { ...g, rt: null }) };
}

/** How the sample is read, or that its type isn't supported. */
export function detect(s: Sample): DetectOutcome {
  const kind = sniffKind(s.head);
  if (typeof kind === "object") return { supported: false, fileName: s.name, type: kind.unsupported, reason: `${kind.unsupported} files aren't supported yet. Ask the sender for CSV, TXT or Excel.` };
  return kind === "text" ? detectText(s) : detectExcel(s);
}
