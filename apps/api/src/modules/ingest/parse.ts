// Delimited files (spec §7 step 1) as a stream of lines Task 5's pipeline reads one at a time. The only file that
// imports csv-parse. A line is either its columns by declared name, or quarantined with a reason per column
// (`_row` when the whole line is at fault: "Expected 14 columns, got 13").
// Event loop: the iterator hands control back to the loop (setImmediate) every `yieldEvery` lines, so a 1M-line file
// never blocks it long enough to starve the job heartbeat (30 s, spike S2); the source is read only as fast as the
// consumer asks (back-pressure).
import { parse } from "csv-parse";

export type ParseFormat = { delimiter: string; header: boolean; encoding: string };
export type ParsedLine =
  | { line: number; ok: true; raw: Record<string, string> }
  | { line: number; ok: false; cells: string[]; reasons: Record<string, string> };
export type ParseOptions = { yieldEvery?: number };

export const WHOLE_ROW = "_row";
const nextTurn = () => new Promise<void>((r) => setImmediate(r));

/** Text chunks (already decoded) to parsed lines. `columns` = the declared field names, in file order. */
async function* lines(chunks: AsyncIterable<string>, f: ParseFormat, columns: string[], yieldEvery: number): AsyncGenerator<ParsedLine> {
  const skipped: ParsedLine[] = [];
  const parser = parse({
    delimiter: f.delimiter, bom: true, relax_column_count: true, skip_empty_lines: true, info: true,
    skip_records_with_error: true,
    on_skip: (err: { message?: string; lines?: number } | undefined, raw: string | undefined) => {
      skipped.push({ line: err?.lines ?? 0, ok: false, cells: raw ? [raw.trimEnd()] : [], reasons: { [WHOLE_ROW]: `Malformed line: ${(err?.message ?? "unreadable").split(/[\n(]/)[0]!.trim()}` } });
    },
  });
  const feed = (async () => {
    try {
      for await (const c of chunks) if (!parser.write(c)) await new Promise((r) => parser.once("drain", r));
      parser.end();
    } catch (e) { parser.destroy(e as Error); }
  })();
  let n = 0, seen = 0;
  try {
    for await (const item of parser as AsyncIterable<{ record: string[]; info: { lines: number } }>) {
      yield* skipped.splice(0);
      const { record: cells, info } = item;
      if (f.header && seen++ === 0) continue;
      if (cells.length !== columns.length) yield { line: info.lines, ok: false, cells, reasons: { [WHOLE_ROW]: `Expected ${columns.length} columns, got ${cells.length}` } };
      else yield { line: info.lines, ok: true, raw: Object.fromEntries(columns.map((c, i) => [c, cells[i]!])) };
      if (++n % yieldEvery === 0) await nextTurn();
    }
    yield* skipped.splice(0);
  } finally {
    parser.destroy();
    await feed;
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
