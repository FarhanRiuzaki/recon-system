// A report as an Excel workbook (SheetJS, DEC-060): one sheet, the template's headers, the rows; a grouped report
// puts each group's line (its name and totals) above its rows and a Total line at the end. SheetJS's community build
// writes no cell styles, so group lines are told by their place and name, not bold.
import { utils, write } from "xlsx";
import { XLSX_ROWS_MAX } from "@starterkit/shared/reports";
import { ApiError } from "../../kernel/errors";
import { groupRows, type ReportRow, type Total } from "./summary";
import type { Column, Written } from "./write-csv";

export async function writeXlsx(pages: AsyncIterable<ReportRow[]>, columns: Column[], out: string, shape: { groups: string[]; totals: Total[] } = { groups: [], totals: [] }, max = XLSX_ROWS_MAX - 1): Promise<Written> {
  const rows: ReportRow[] = [];
  for await (const page of pages) {
    rows.push(...page);
    if (rows.length > max) throw new ApiError("bad_request", "Excel holds at most 1,048,576 rows. Use CSV for more.");
  }
  const cells = (r: ReportRow) => columns.map((c) => r.values[c.key] ?? null);
  const aoa: (string | number | null)[][] = [columns.map((c) => c.header)];
  if (shape.groups.length) {
    for (const s of groupRows(rows, shape.groups, shape.totals)) {
      aoa.push(s.kind === "row" ? cells(s.row!) : [`${"  ".repeat(s.level)}${s.label ?? ""}`, ...(s.totals ?? [])]);
    }
  } else for (const r of rows) aoa.push(cells(r));
  const wb = utils.book_new();
  utils.book_append_sheet(wb, utils.aoa_to_sheet(aoa), "Report");
  const bytes = new Uint8Array(write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer);
  await Bun.write(out, bytes);
  return { rows: rows.length, size: bytes.length, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
}
