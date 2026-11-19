// Delimited files (spec §7 step 1) as a stream of lines Task 5's pipeline reads one at a time. The only file that
// imports csv-parse. A line is either its columns by declared name, or quarantined with a reason per column
// (`_row` when the whole line is at fault: "Expected 14 columns, got 13").
// Event loop: the iterator hands control back to the loop (setImmediate) every `yieldEvery` lines, so a 1M-line file
// never blocks it long enough to starve the job heartbeat (30 s, spike S2); the source is read only as fast as the
// consumer asks (back-pressure).
import { parse } from "csv-parse";

export type ParseFormat = { delimiter: string; header: boolean; encoding: string; /** the quote character; null = no quoting (default `"`) */ quote?: string | null };
export type ParsedLine =
  | { line: number; ok: true; raw: Record<string, string> }
  | { line: number; ok: false; cells: string[]; reasons: Record<string, string> };
export type ParseOptions = { yieldEvery?: number };

export const WHOLE_ROW = "_row";
/** A line (quoted fields included) longer than this is quarantined: a stray quote can't buffer the rest of the file. */
export const MAX_LINE_BYTES = 1024 * 1024;
const nextTurn = () => new Promise<void>((r) => setImmediate(r));
const newlines = (s: string) => s.split("\n").length - 1;

/** csv-parse's error as one sentence-case reason: "Quote not closed (line 4)". */
function reasonOf(err: { message?: string; code?: string } | undefined, line: number): string {
  if (err?.code === "CSV_MAX_RECORD_SIZE") return `Line longer than ${MAX_LINE_BYTES / 1024 / 1024} MB (line ${line})`;
  const head = (err?.message ?? "Unreadable line").split(/[:(\n]/)[0]!.trim();
  return `${head.charAt(0).toUpperCase()}${head.slice(1).toLowerCase()} (line ${line})`;
}

/** Text chunks (already decoded) to parsed lines. `columns` = the declared field names, in file order. */
async function* lines(chunks: AsyncIterable<string>, f: ParseFormat, columns: string[], yieldEvery: number): AsyncGenerator<ParsedLine> {
  const skipped: ParsedLine[] = [];
  const parser = parse({
    delimiter: f.delimiter, quote: f.quote === undefined ? '"' : f.quote, bom: true, relax_column_count: true, skip_empty_lines: true, info: true, raw: true,
    max_record_size: MAX_LINE_BYTES, skip_records_with_error: true,
    on_skip: (err: { message?: string; code?: string; lines?: number } | undefined, raw: string | undefined) => {
      const text = (raw ?? "").replace(/\r?\n$/, "");
      const line = Math.max(1, (err?.lines ?? 1) - newlines(text)); // csv-parse reports where it noticed; the line starts where its text began
      skipped.push({ line, ok: false, cells: [text.slice(0, 1000)], reasons: { [WHOLE_ROW]: reasonOf(err, line) } });
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
  let n = 0, seen = 0;
  try {
    for await (const item of parser as AsyncIterable<{ record: string[]; raw: string; info: { lines: number } }>) {
      const { record: cells, info } = item;
      const start = info.lines - newlines(item.raw.replace(/\r?\n$/, ""));
      while (skipped.length && skipped[0]!.line < start) yield skipped.shift()!;
      if (f.header && seen++ === 0) continue;
      if (cells.length !== columns.length) yield { line: start, ok: false, cells, reasons: { [WHOLE_ROW]: `Expected ${columns.length} columns, got ${cells.length}` } };
      else yield { line: start, ok: true, raw: Object.fromEntries(columns.map((c, i) => [c, cells[i]!])) };
      if (++n % yieldEvery === 0) await nextTurn();
    }
    yield* skipped.splice(0);
  } finally {
    parser.destroy();
    void it.return?.(); // closes the source; not awaited: a source blocked in a read can't hold the consumer
    void feed;
  }
}

/** A byte stream (file, SFTP, response body) to parsed lines, decoded as `format.encoding` (a multi-byte character may span chunks). */
export function parseDelimited(source: AsyncIterable<Uint8Array>, format: ParseFormat, columns: string[], opts: ParseOptions = {}): AsyncGenerator<ParsedLine> {
  const decoder = new TextDecoder(format.encoding as "utf-8"); // the encoding labels FILE_ENCODINGS names
  async function* text() {
    for await (const b of source) yield decoder.decode(b, { stream: true });
    yield decoder.decode();
  }
  return lines(text(), format, columns, opts.yieldEvery ?? 1000);
}

/** A small text held in memory (the preview's sample) to all its lines. */
export async function parseText(text: string, format: ParseFormat, columns: string[]): Promise<ParsedLine[]> {
  const out: ParsedLine[] = [];
  for await (const l of lines((async function* () { yield text; })(), format, columns, 1000)) out.push(l);
  return out;
}
