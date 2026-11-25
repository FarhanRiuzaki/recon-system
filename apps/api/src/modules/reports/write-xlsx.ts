// A report as an Excel workbook (SheetJS, DEC-060): one sheet from A1 with the title, the header block (label, value),
// the column headers, the lines (numbers as numbers), and the footer's text with the stamp; each part only when on.
// SheetJS's community build writes no cell styles, so group lines are told by their place and name.
import { utils, write } from "xlsx";
import { XLSX_ROWS_MAX } from "@starterkit/shared/reports";
import { ApiError } from "../../kernel/errors";
import type { Line, Sheet } from "./lines";
import type { Written } from "./write-csv";

export async function writeXlsx(pages: AsyncIterable<Line[]>, sheet: Sheet, out: string, max = XLSX_ROWS_MAX - 1): Promise<Written> {
  const aoa: (string | number)[][] = [];
  if (sheet.title) aoa.push([sheet.title]);
  for (const h of sheet.header ?? []) aoa.push([h.label, h.value]);
  if (sheet.columnHeaders) aoa.push(sheet.headers);
  let rows = 0;
  for await (const page of pages) {
    for (const l of page) {
      aoa.push(l.values);
      if (l.kind === "row") rows++;
      if (aoa.length > max) throw new ApiError("bad_request", "Excel holds at most 1,048,576 rows. Use CSV for more.");
    }
  }
  if (sheet.footer && (sheet.footer.text || sheet.footer.stamp)) aoa.push([sheet.footer.text, ...(sheet.footer.stamp ? [sheet.footer.stamp] : [])]);
  const ws = utils.aoa_to_sheet(aoa);
  ws["!cols"] = sheet.layouts.map((l) => ({ wch: Math.max(6, Math.min(60, l.width + 2)) }));
  const wb = utils.book_new();
  utils.book_append_sheet(wb, ws, "Report");
  const bytes = new Uint8Array(write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
  await Bun.write(out, bytes);
  return { rows, size: bytes.length, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
}
