// A report as CSV (spec 2026-11-26): the header block as label,value lines, the column headers, the rows (group and
// subtotal lines only when asked), the total line, then the footer's text; each part only when on. Text cells that
// would start a formula are neutralized (AGENTS.md §3); a number never is, so "-25,00" stays as written.
import { type Line, type Sheet, shown, toAscii } from "./lines";

export type Written = { rows: number; size: number; sha256: string };

/** Writes `chunks` through one hasher; answers the size and SHA-256. */
export function fileSink(out: string) {
  const file = Bun.file(out).writer();
  const hash = new Bun.CryptoHasher("sha256");
  let size = 0;
  return {
    put(s: string) { const b = Buffer.from(s, "utf8"); hash.update(b); size += b.length; file.write(b); },
    flush: () => file.flush(),
    async end() { await file.end(); return { size, sha256: hash.digest("hex") }; },
  };
}

function cell(v: string, text: boolean, sheet: Sheet): string {
  let s = sheet.ascii ? toAscii(v) : v;
  if (text && (/^\s*[=+\-@]/.test(s) || /^[\t\r]/.test(s))) s = `'${s}`;
  const special = s.includes(sheet.delimiter) || /["\n\r]/.test(s);
  return sheet.quoteAll || special ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function writeCsvFile(pages: AsyncIterable<Line[]>, sheet: Sheet, out: string): Promise<Written> {
  const sink = fileSink(out);
  const line = (cells: string[], text: boolean[]) => sink.put(cells.map((c, i) => cell(c, text[i] ?? true, sheet)).join(sheet.delimiter) + sheet.eol);
  if (!sheet.ascii) sink.put("﻿");
  for (const h of sheet.header ?? []) line([h.label, h.value], [true, true]);
  if (sheet.columnHeaders) line(sheet.headers, sheet.headers.map(() => true));
  let rows = 0;
  for await (const page of pages) {
    for (const l of page) {
      if (!shown(l, sheet, true)) continue;
      line(l.cells, l.text);
      if (l.kind === "row") rows++;
    }
    await sink.flush();
  }
  if (sheet.footer?.text) line([sheet.footer.text], [true]);
  return { rows, ...(await sink.end()) };
}
