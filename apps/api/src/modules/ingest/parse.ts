// Delimited files (spec §7 step 1) as a stream of lines Task 5's pipeline reads one at a time. The only file that
// imports csv-parse. A line is either its columns by declared name, or quarantined with a reason per column
// (`_row` when the whole line is at fault: "Expected 14 columns, got 13").
// Event loop: the iterator hands control back to the loop (setImmediate) every `yieldEvery` lines, so a 1M-line file
// never blocks it long enough to starve the job heartbeat (30 s, spike S2); the source is read only as fast as the
// consumer asks (back-pressure).
import { parse } from "csv-parse";
import type { FileFormat } from "@starterkit/shared/contracts/sources";
import { readRows, readText } from "./read";
import type { DriftColumn } from "./rules";

export type ParseFormat = { delimiter: string; header: boolean; encoding: string; /** the quote character; null = no quoting (default `"`) */ quote?: string | null };

/** A file format as the delimited parser reads it; another kind is the file reader's (read.ts) and refused here. */
export function delimitedOf(f: { kind: string } & Partial<ParseFormat>): ParseFormat {
  if (f.kind !== "delimited") throw new Error(`parse: ${f.kind} isn't delimited`);
  return f as ParseFormat;
}
/**
 * A line, or why it can't be read. `fatal` marks a fault of the whole file, not of one line: "file" = a quote never
 * closed or a line over MAX_LINE_BYTES (the rest of the file can't be trusted), "schema" = a header whose column count
 * isn't the declared one, or whose names (trimmed) aren't the declared ones in that order (the sender changed the
 * layout; `drift` per column for a name). The wizard's col_NN placeholders are not compared. The pipeline fails such a
 * file; the preview lists it.
 */
export type ParsedLine =
  | { line: number; ok: true; raw: Record<string, string> }
  | { line: number; ok: false; cells: string[]; reasons: Record<string, string>; fatal?: "file" | "schema"; drift?: DriftColumn[] };
export type ParseOptions = { yieldEvery?: number };

export const WHOLE_ROW = "_row";
/** A line (quoted fields included) longer than this is quarantined: a stray quote can't buffer the rest of the file. */
export const MAX_LINE_BYTES = 1024 * 1024;
const newlines = (s: string) => s.split("\n").length - 1;
/** The name the wizard gives a column without one (an empty or repeated header cell, a headerless file). */
const PLACEHOLDER = /^col_\d+$/;

/** The declared columns the header names differently, in file order (placeholders skipped). */
function headerDrift(cells: string[], columns: string[]): DriftColumn[] {
  return columns.flatMap((c, i) => (PLACEHOLDER.test(c) || cells[i]!.trim() === c ? [] : [{
    column: c, expected: `"${c}" in column ${i + 1}`, found: `"${cells[i]!.trim()}"`,
    effect: "The file's header names another column here, so its values would be read into the wrong field. Make a new version for the file's layout.",
  }]));
}

/** csv-parse's error as one sentence-case reason: "Quote not closed (line 4)". */
function reasonOf(err: { message?: string; code?: string } | undefined, line: number): string {
  if (err?.code === "CSV_MAX_RECORD_SIZE") return `Line longer than ${MAX_LINE_BYTES / 1024 / 1024} MB (line ${line})`;
  const head = (err?.message ?? "Unreadable line").split(/[:(\n]/)[0]!.trim();
  return `${head.charAt(0).toUpperCase()}${head.slice(1).toLowerCase()} (line ${line})`;
}

/** A record split into cells, or a line that couldn't be split (quarantined as it is). */
export type CellRecord = { line: number; cells: string[] } | { line: number; bad: ParsedLine };

/** Text chunks (already decoded) to delimited records, in line order (csv-parse; the reader shapes them, read.ts). */
export async function* delimitedCells(chunks: AsyncIterable<string>, f: ParseFormat): AsyncGenerator<CellRecord> {
  const skipped: ParsedLine[] = [];
  const parser = parse({
    delimiter: f.delimiter, quote: f.quote === undefined ? '"' : f.quote, bom: true, relax_column_count: true, skip_empty_lines: true, info: true, raw: true,
    // a quote inside an unquoted value is text (RFC 4180 quotes a value only at its start): JSON in a pipe file
    relax_quotes: true,
    max_record_size: MAX_LINE_BYTES, skip_records_with_error: true,
    on_skip: (err: { message?: string; code?: string; lines?: number } | undefined, raw: string | undefined) => {
      const text = (raw ?? "").replace(/\r?\n$/, "");
      const line = Math.max(1, (err?.lines ?? 1) - newlines(text)); // csv-parse reports where it noticed; the line starts where its text began
      const fatal = err?.code === "CSV_QUOTE_NOT_CLOSED" || err?.code === "CSV_MAX_RECORD_SIZE" ? { fatal: "file" as const } : {};
      // csv-parse can report one line more than once (each bad character): the line is quarantined once
      if (skipped.at(-1)?.line === line) return;
      skipped.push({ line, ok: false, cells: [text.slice(0, 1000)], reasons: { [WHOLE_ROW]: reasonOf(err, line) }, ...fatal });
    },
  });
  const it = chunks[Symbol.asyncIterator]();
  // The feed stops as soon as the parser is gone (the consumer stopped) and never waits on a drain that can't come.
  const feed = (async () => {
    try {
      for (;;) {
        if (parser.destroyed) return;
        const { done, value } = await it.next();
        if (done) break;
        if (!parser.write(value) && !parser.destroyed) await new Promise<void>((r) => {
          const go = () => { parser.off("drain", go); parser.off("close", go); r(); };
          parser.on("drain", go).on("close", go);
        });
      }
      if (!parser.destroyed) parser.end();
    } catch (e) { parser.destroy(e as Error); }
  })();
  try {
    for await (const item of parser as AsyncIterable<{ record: string[]; raw: string; info: { lines: number } }>) {
      const start = item.info.lines - newlines(item.raw.replace(/\r?\n$/, ""));
      while (skipped.length && skipped[0]!.line < start) { const b = skipped.shift()!; yield { line: b.line, bad: b }; }
      yield { line: start, cells: item.record };
    }
    for (const b of skipped.splice(0)) yield { line: b.line, bad: b };
  } finally {
    parser.destroy();
    // closes the source; not awaited (a source blocked in a read can't hold the consumer), and its rejection is
    // dropped: unhandled, it would end the worker process
    it.return?.()?.catch(() => {});
    void feed;
  }
}

/** The header check of a delimited or fixed-length file: its cell count and names against the declared columns. */
export function headerProblem(cells: string[], columns: string[], line: number): ParsedLine | null {
  if (cells.length !== columns.length) return { line, ok: false, cells, reasons: { [WHOLE_ROW]: `The header has ${cells.length} columns; the source declares ${columns.length}` }, fatal: "schema" };
  const drift = headerDrift(cells, columns);
  const said = drift.map((d) => `column ${columns.indexOf(d.column) + 1} is ${d.found}, declared "${d.column}"`).join("; ");
  return drift.length ? { line, ok: false, cells, reasons: { [WHOLE_ROW]: `The header's columns are not the declared ones: ${said}. Make a new source version for the file's layout.` }, fatal: "schema", drift } : null;
}

/** A byte stream (file, SFTP, response body) to parsed lines: the file reader's delimited kind (read.ts). */
export function parseDelimited(source: AsyncIterable<Uint8Array>, format: ParseFormat, columns: string[], opts: ParseOptions = {}): AsyncGenerator<ParsedLine> {
  return readRows(source, { kind: "delimited", ...format, quote: format.quote === undefined ? '"' : format.quote } as FileFormat, columns, opts);
}

/** A small text held in memory (the preview's sample) to all its lines. */
export function parseText(text: string, format: ParseFormat, columns: string[]): Promise<ParsedLine[]> {
  return readText(text, { kind: "delimited", ...format, quote: format.quote === undefined ? '"' : format.quote } as FileFormat, columns);
}
