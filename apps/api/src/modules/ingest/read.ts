// The file reader (DEC-058): one iterator for every kind of file a source reads, used by the pipeline and the preview
// alike, so the preview shows what ingest loads. Text kinds (delimited, fixed-length) are decoded and streamed line by
// line; an Excel workbook is read whole (excel.ts). Then the same shaping for every kind: rows dropped at the top
// (`skip_top`) and the bottom (`skip_bottom`, counted in records, so a quoted line break doesn't shift it), the header
// (its names checked against the declared columns), record types (a header line's columns carried by the details
// under it), and each row's cell count against the declared columns.
import type { FileFormat, RecordTypes } from "@starterkit/shared/contracts/sources";
import { decodeStream } from "./decode";
import { workbookRecords } from "./excel";
import { type CellRecord, delimitedCells, headerProblem, MAX_LINE_BYTES, type ParsedLine, type ParseOptions, WHOLE_ROW } from "./parse";

type Fixed = Extract<FileFormat, { kind: "fixed_width" }>;
type Pos = { start: number; length: number };

const nextTurn = () => new Promise<void>((r) => setImmediate(r));
const cut = (line: string, cols: readonly Pos[]) => cols.map((c) => line.slice(c.start - 1, c.start - 1 + c.length));

/** Text to its non-empty lines as one-cell records (a fixed-length line is cut later: its type may choose the positions). */
async function* textLines(chunks: AsyncIterable<string>): AsyncGenerator<CellRecord> {
  let rest = "", n = 0;
  for await (const c of chunks) {
    const parts = (rest + c).split("\n");
    rest = parts.pop()!;
    // a line past the limit (no line feeds: old Mac endings, a binary): the rest of the file can't be trusted
    if (rest.length > MAX_LINE_BYTES || parts.some((x) => x.length > MAX_LINE_BYTES)) {
      yield { line: n + 1, bad: { line: n + 1, ok: false, cells: [rest.slice(0, 1000)], reasons: { [WHOLE_ROW]: `Line longer than ${MAX_LINE_BYTES / 1024 / 1024} MB (line ${n + 1})` }, fatal: "file" } };
      return;
    }
    for (const p of parts) { n += 1; const l = p.replace(/\r$/, ""); if (l.length) yield { line: n, cells: [l] }; }
  }
  const l = rest.replace(/\r$/, "");
  if (l.length) yield { line: n + 1, cells: [l] };
}

/** Holds the last `n` records back and drops them at the end; a record `through` picks (a line that couldn't be read) is never held or dropped. */
async function* dropLast<T>(it: AsyncIterable<T>, n: number, through: (x: T) => boolean): AsyncGenerator<T> {
  if (!n) { yield* it; return; }
  const held: T[] = [];
  for await (const x of it) {
    if (through(x)) { yield x; continue; }
    held.push(x);
    if (held.length > n) yield held.shift()!;
  }
}

/** The record type of a line (by its marker), or why it has none. */
function typeOf(rt: RecordTypes, raw: string, cells: string[]) {
  const code = rt.marker.kind === "prefix" ? raw.slice(0, rt.marker.length) : (cells[rt.marker.index] ?? "");
  return { code, type: rt.types.find((t) => t.code === code.trim()) ?? rt.types.find((t) => t.code === code) };
}

/** Shapes records into parsed lines (the kinds' common part). `fixed`: the positions when the lines are fixed-length. */
async function* shape(records: AsyncIterable<CellRecord>, f: FileFormat, columns: string[], yieldEvery: number, fixed: Fixed | null): AsyncGenerator<ParsedLine> {
  const rt = f.kind === "excel" ? undefined : f.records;
  const headerCount = rt?.types.find((t) => t.role === "header")?.count ?? 0;
  let skip = f.skip_top ?? 0, headed = !f.header, carried: string[] | null = null, n = 0;
  for await (const r of dropLast(records, f.skip_bottom ?? 0, (x) => "bad" in x)) {
    if ("bad" in r) { yield r.bad; continue; }
    if (skip > 0) { skip -= 1; continue; }
    const raw = fixed ? r.cells[0]! : "";
    if (!headed) {
      headed = true;
      if (!rt) { const p = headerProblem(fixed ? cut(raw, fixed.columns) : r.cells, columns, r.line); if (p) yield p; }
      continue;
    }
    let cells: string[];
    if (rt) {
      const { code, type } = typeOf(rt, raw, r.cells);
      if (!type) { yield { line: r.line, ok: false, cells: fixed ? [raw] : r.cells, reasons: { [WHOLE_ROW]: `Unknown record type ${code.trim() || "(empty)"}` } }; continue; }
      if (type.role === "skip") continue;
      const own = fixed ? cut(raw, type.columns ?? []) : r.cells;
      if (!fixed && own.length !== type.count) { yield { line: r.line, ok: false, cells: own, reasons: { [WHOLE_ROW]: `Expected ${type.count} columns for record type ${type.code}, got ${own.length}` } }; continue; }
      if (type.role === "header") { carried = own; continue; }
      cells = [...(carried ?? Array.from({ length: headerCount }, () => "")), ...own];
    } else {
      cells = fixed ? cut(raw, fixed.columns) : r.cells;
    }
    if (cells.length !== columns.length) yield { line: r.line, ok: false, cells, reasons: { [WHOLE_ROW]: `Expected ${columns.length} columns, got ${cells.length}` } };
    else yield { line: r.line, ok: true, raw: Object.fromEntries(columns.map((c, i) => [c, cells[i]!])) };
    if (++n % yieldEvery === 0) await nextTurn();
  }
}

/** Decoded text to the records of a text kind. */
function textRecords(chunks: AsyncIterable<string>, f: Exclude<FileFormat, { kind: "excel" }>): AsyncIterable<CellRecord> {
  return f.kind === "fixed_width" ? textLines(chunks) : delimitedCells(chunks, { delimiter: f.delimiter, quote: f.quote, header: f.header, encoding: f.encoding });
}

/** A byte stream to parsed lines under `format`: `columns` = the declared field names, in order. */
export function readRows(source: AsyncIterable<Uint8Array>, format: FileFormat, columns: string[], opts: ParseOptions = {}): AsyncGenerator<ParsedLine> {
  if (format.kind === "excel") return excelRows(source, format, columns, opts);
  return shape(textRecords(decodeStream(source, format.encoding), format), format, columns, opts.yieldEvery ?? 1000, format.kind === "fixed_width" ? format : null);
}

/** An Excel workbook: its bytes gathered (stopping past the limit), its sheet's rows, then the same shaping. */
async function* excelRows(source: AsyncIterable<Uint8Array>, format: Extract<FileFormat, { kind: "excel" }>, columns: string[], opts: ParseOptions): AsyncGenerator<ParsedLine> {
  const max = opts.excelMaxMb ?? 50;
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const b of source) { size += b.length; if (size > max * 1024 * 1024) break; parts.push(b); }
  // over the limit: the size alone says so (workbookRecords answers the fault without reading it)
  const bytes = size > max * 1024 * 1024 ? { length: size } as Uint8Array : Buffer.concat(parts);
  yield* shape((async function* () { yield* workbookRecords(bytes, format, max); })(), format, columns, opts.yieldEvery ?? 1000, null);
}

/** An Excel workbook already in memory (a sample) to all its lines. */
export async function readWorkbook(bytes: Uint8Array, format: Extract<FileFormat, { kind: "excel" }>, columns: string[], maxMb = 50): Promise<ParsedLine[]> {
  const out: ParsedLine[] = [];
  for await (const l of shape((async function* () { yield* workbookRecords(bytes, format, maxMb); })(), format, columns, 1000, null)) out.push(l);
  return out;
}

/** A small text held in memory (a pasted preview sample) to all its lines. */
export async function readText(text: string, format: FileFormat, columns: string[]): Promise<ParsedLine[]> {
  if (format.kind === "excel") throw new Error("read: Excel is bytes, not text");
  const out: ParsedLine[] = [];
  for await (const l of shape(textRecords((async function* () { yield text; })(), format), format, columns, 1000, format.kind === "fixed_width" ? format : null)) out.push(l);
  return out;
}
