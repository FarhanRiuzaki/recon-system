// Excel workbooks for the file reader (DEC-058): .xlsx and legacy .xls through SheetJS, the one module that imports it.
// A workbook can't be streamed: it is read whole, after its size is checked. Cells become the text a person reads:
// text as is (0012 keeps its zeros), a date cell yyyy-MM-dd (or yyyy-MM-ddTHH:mm:ss with a time), a number in plain
// decimal (no grouping, no exponent, float noise rounded to 15 digits), a boolean true/false. Blank rows are skipped.
import type { FileFormat } from "@starterkit/shared/contracts/sources";
import { type CellObject, read as readXlsx, SSF, utils, type WorkBook } from "xlsx";
import type { CellRecord, ParsedLine } from "./parse";
import { WHOLE_ROW } from "./parse";

type Excel = Extract<FileFormat, { kind: "excel" }>;
const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** A number as plain decimal text. */
function plain(v: number): string {
  const r = Number(v.toPrecision(15));
  return Math.abs(r) >= 1e21 || (r !== 0 && Math.abs(r) < 1e-6) ? r.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 }) : String(r);
}

/** A cell's text. */
export function cellText(c: CellObject | undefined): string {
  if (!c || c.v === undefined || c.v === null) return "";
  if (c.t === "n" && typeof c.v === "number" && c.z && SSF.is_date(c.z)) {
    const d = SSF.parse_date_code(c.v);
    const day = `${pad(d.y, 4)}-${pad(d.m)}-${pad(d.d)}`;
    return d.H || d.M || d.S ? `${day}T${pad(d.H)}:${pad(d.M)}:${pad(Math.floor(d.S))}` : day;
  }
  if (c.t === "n") return plain(c.v as number);
  if (c.t === "b") return c.v ? "true" : "false";
  if (c.t === "e") return "";
  return String(c.v);
}

const read = (bytes: Uint8Array) => readXlsx(bytes, { type: "array", cellNF: true, cellDates: false, dense: false });

/** The workbook's sheet names, in order. */
export const sheetNames = (bytes: Uint8Array): string[] => read(bytes).SheetNames;

/** The sheet `sheet` names: the first, by name, or the first whose name matches a glob (`ACT*`). */
export function pickSheet(names: readonly string[], sheet: Excel["sheet"]): string | null {
  if (sheet.kind === "first") return names[0] ?? null;
  if (sheet.kind === "name") return names.find((n) => n === sheet.name) ?? names.find((n) => n.toLowerCase() === sheet.name.toLowerCase()) ?? null;
  const g = new Bun.Glob(sheet.pattern);
  return names.find((n) => g.match(n)) ?? names.find((n) => new Bun.Glob(sheet.pattern.toLowerCase()).match(n.toLowerCase())) ?? null;
}

const fault = (reason: string): ParsedLine => ({ line: 1, ok: false, cells: [], reasons: { [WHOLE_ROW]: reason }, fatal: "file" });

/**
 * The rows of the workbook's chosen sheet as cell records (line = the sheet's row number), or a fault of the whole file:
 * over `maxMb`, not a workbook, or no such sheet.
 */
export function workbookRecords(bytes: Uint8Array, format: Excel, maxMb: number): CellRecord[] {
  if (bytes.length > maxMb * 1024 * 1024) return [{ line: 1, bad: fault(`The workbook is over ${maxMb} MB.`) }];
  let wb: WorkBook;
  try { wb = read(bytes); } catch { return [{ line: 1, bad: fault("The file can't be opened as an Excel workbook.") }]; }
  const name = pickSheet(wb.SheetNames, format.sheet);
  if (!name) {
    const want = format.sheet.kind === "name" ? `named ${format.sheet.name}` : format.sheet.kind === "pattern" ? `matching ${format.sheet.pattern}` : "at all";
    return [{ line: 1, bad: fault(`No sheet ${want} (sheets: ${wb.SheetNames.join(", ")}).`) }];
  }
  const ws = wb.Sheets[name]!;
  if (!ws["!ref"]) return [];
  const range = utils.decode_range(ws["!ref"]);
  const out: CellRecord[] = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const cells: string[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) cells.push(cellText(ws[utils.encode_cell({ r, c })]));
    while (cells.length && cells.at(-1) === "") cells.pop();
    if (cells.length) out.push({ line: r + 1, cells });
  }
  return out;
}
