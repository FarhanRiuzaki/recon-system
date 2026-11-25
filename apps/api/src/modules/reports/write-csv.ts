// A report as CSV (UTF-8 with BOM for Excel): the template's headers, then each row's cells in column order, written as
// the pages arrive; cells that would start a formula are neutralized (AGENTS.md §3, `toCsv`).
import { CSV_BOM, toCsv } from "@starterkit/ui/lib/csv";
import type { ReportRow } from "./summary";

export type Written = { rows: number; size: number; sha256: string };
export type Column = { key: string; header: string };

/** A cell that is only a number (`-1500`, `12.5`) goes as a number, so a negative one isn't prefixed like a formula. */
const plainNumber = (v: string | null): string | number | null => (v !== null && /^-?\d{1,15}(\.\d{1,15})?$/.test(v) && Number.isFinite(Number(v)) && String(Number(v)) === v ? Number(v) : v);

/** Streams `pages` to `out`; answers how many rows, the size and the SHA-256 of what was written. */
export async function writeCsvFile(pages: AsyncIterable<ReportRow[]>, columns: Column[], out: string): Promise<Written> {
  const file = Bun.file(out).writer();
  const hash = new Bun.CryptoHasher("sha256");
  let size = 0, rows = 0;
  const put = (s: string) => { const b = Buffer.from(s, "utf8"); hash.update(b); size += b.length; file.write(b); };
  put(CSV_BOM + toCsv([columns.map((c) => c.header)]));
  for await (const page of pages) {
    if (!page.length) continue;
    put(toCsv(page.map((r) => columns.map((c) => plainNumber(r.values[c.key] ?? null)))));
    rows += page.length;
    await file.flush();
  }
  await file.end();
  return { rows, size, sha256: hash.digest("hex") };
}
