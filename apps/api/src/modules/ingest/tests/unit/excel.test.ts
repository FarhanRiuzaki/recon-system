// Excel workbooks (excel.ts): the sheet by name or pattern, skips and header, cell values as text a person reads.
import { describe, expect, it } from "bun:test";
import * as XLSX from "xlsx";
import type { ParsedLine } from "../../parse";
import { sheetNames } from "../../excel";
import { readWorkbook } from "../../read";

const okRows = (ls: ParsedLine[]) => ls.filter((l) => l.ok).map((l) => (l as Extract<ParsedLine, { ok: true }>).raw);
const reasons = (ls: ParsedLine[]) => ls.filter((l) => !l.ok).map((l) => Object.values((l as Extract<ParsedLine, { ok: false }>).reasons)[0]);

function book(bookType: "xlsx" | "biff8" = "xlsx"): Uint8Array {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Summary"], ["total", 2]]), "Summary");
  const ws = XLSX.utils.aoa_to_sheet([["ACT report 25 Nov"], ["ref", "date", "amount", "rate"], ["0012", new Date(Date.UTC(2026, 10, 25)), 1500000, 0.1 + 0.2]], { cellDates: true });
  ws.A3 = { t: "s", v: "0012" };
  XLSX.utils.book_append_sheet(wb, ws, "ACT 25-11");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType }) as ArrayBuffer);
}

describe("readWorkbook", () => {
  it("reads the sheet a pattern names, after its title row, with text, dates and numbers as a person reads them", async () => {
    expect(sheetNames(book())).toEqual(["Summary", "ACT 25-11"]);
    const ls = await readWorkbook(book(), { kind: "excel", sheet: { kind: "pattern", pattern: "ACT*" }, header: true, skip_top: 1 }, ["ref", "date", "amount", "rate"], 50);
    expect(okRows(ls)).toEqual([{ ref: "0012", date: "2026-11-25", amount: "1500000", rate: "0.3" }]);
  });

  it("a legacy .xls reads the same", async () => {
    const ls = await readWorkbook(book("biff8"), { kind: "excel", sheet: { kind: "name", name: "ACT 25-11" }, header: true, skip_top: 1 }, ["ref", "date", "amount", "rate"], 50);
    expect(okRows(ls)[0]).toMatchObject({ ref: "0012", amount: "1500000" });
  });

  it("a sheet that isn't there is a fault of the whole file, naming the sheets it has", async () => {
    const ls = await readWorkbook(book(), { kind: "excel", sheet: { kind: "name", name: "Nope" }, header: false }, ["a"], 50);
    expect(ls[0]).toMatchObject({ ok: false, fatal: "file" });
    expect(reasons(ls)).toEqual(["No sheet named Nope (sheets: Summary, ACT 25-11)."]);
  });

  it("a workbook over the size limit is refused before it is read", async () => {
    const ls = await readWorkbook(new Uint8Array(2 * 1024 * 1024), { kind: "excel", sheet: { kind: "first" }, header: false }, ["a"], 1);
    expect(reasons(ls)).toEqual(["The workbook is over 1 MB."]);
  });
});
