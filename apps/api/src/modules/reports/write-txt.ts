// A report as Text fixed-width (spec 2026-11-26): every line is the columns side by side at their widths (cut, padded
// by alignment, numbers zero-padded when asked with the sign first). The header block's lines are a header record
// (the label in the first column's width, then the value), the footer's text the trailer record.
import { fitWidth } from "@starterkit/shared/report-format";
import { type Line, type Sheet, shown, toAscii } from "./lines";
import { fileSink, type Written } from "./write-csv";

const lineOf = (l: Line, sheet: Sheet) => l.cells.map((c, i) => fitWidth(c, sheet.layouts[i]!, sheet.numeric[i]! && !l.text[i])).join("");
const first = (sheet: Sheet) => sheet.layouts[0] ?? { align: "l" as const, width: 10, pad: " " as const };
const headLines = (sheet: Sheet) => [
  ...(sheet.header ?? []).map((h) => fitWidth(h.label, { ...first(sheet), align: "l", pad: " " }, false) + h.value),
  ...(sheet.columnHeaders ? [sheet.headers.map((h, i) => fitWidth(h, { ...sheet.layouts[i]!, pad: " " }, false)).join("")] : []),
];

/** The file's lines (without line ends): what the preview's Text view shows. */
export function txtLines(lines: Line[], sheet: Sheet): string[] {
  const out = [...headLines(sheet), ...lines.filter((l) => shown(l, sheet, true)).map((l) => lineOf(l, sheet)), ...(sheet.footer?.text ? [sheet.footer.text] : [])];
  return sheet.ascii ? out.map(toAscii) : out;
}

export async function writeTxt(pages: AsyncIterable<Line[]>, sheet: Sheet, out: string): Promise<Written> {
  const sink = fileSink(out);
  const put = (s: string) => sink.put((sheet.ascii ? toAscii(s) : s) + sheet.eol);
  for (const h of headLines(sheet)) put(h);
  let rows = 0;
  for await (const page of pages) {
    for (const l of page) {
      if (!shown(l, sheet, true)) continue;
      put(lineOf(l, sheet));
      if (l.kind === "row") rows++;
    }
    await sink.flush();
  }
  if (sheet.footer?.text) put(sheet.footer.text);
  return { rows, ...(await sink.end()) };
}
