// Report writers v2 (spec 2026-11-26): one design to CSV, Text fixed-width, Excel and the PDF's HTML; every section
// optional ("Data only"); CSV/Text header block and footer as the file's first and last lines.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { read } from "xlsx";
import type { ReportSpec } from "@starterkit/shared/contracts/reports";
import { columnFor, emptySpec } from "@starterkit/shared/report-spec";
import { type DataRow, renderRow, rendererOf } from "../../cells";
import { linesOf, type Line, sheetOf } from "../../lines";
import { reportHtml } from "../../pdf-html";
import { writeCsvFile } from "../../write-csv";
import { writeTxt } from "../../write-txt";
import { writeXlsx } from "../../write-xlsx";

const dir = mkdtempSync(path.join(tmpdir(), "reports-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const rows: DataRow[] = [
  { date: "2026-11-25", values: { "a:ext_ref": "R1", "a:account_ref": "1002345678", "a:amount_minor": 1500, "recon:status": "matched" } },
  { date: "2026-11-25", values: { "a:ext_ref": "=SUM(1)", "a:account_ref": "", "a:amount_minor": -25, "recon:status": "unmatch" } },
];
const amount = (decimals: number, thousands: "." | "none") => ({ ...columnFor("c3", "a:amount_minor", "Amount"), format: { kind: "number" as const, decimals, thousands, negative: "minus" as const, prefix: "", suffix: "" }, layout: { align: "r" as const, width: 12, pad: "0" as const } });
const design = (o: Partial<ReportSpec> = {}, decimals = 2, thousands: "." | "none" = "."): ReportSpec => {
  const e = emptySpec();
  return {
    ...e, columns: [{ ...columnFor("c1", "a:ext_ref", "Reference"), layout: { align: "l", width: 10, pad: " " } }, { ...columnFor("c2", "a:account_ref", "Account"), layout: { align: "l", width: 10, pad: " " } }, amount(decimals, thousands)],
    totals: { on: true, perGroup: true, columns: { c3: "sum" } },
    sections: { title: { on: true, text: "Daily {recon}" }, header: { on: true, lines: [{ label: "Bank", value: { kind: "text", text: "PT Contoh" } }] }, columnHeaders: true, footer: { on: true, stamp: true, pageNumbers: true, text: "End of file" } },
    ...o,
  };
};
const dataOnly = (s: ReportSpec): ReportSpec => ({ ...s, totals: { ...s.totals, on: false }, sections: { title: { ...s.sections.title, on: false }, header: { ...s.sections.header, on: false }, columnHeaders: false, footer: { ...s.sections.footer, on: false } } });
const ctx = { recon: "KSEI", template: "Daily", from: "2026-11-25", to: "2026-11-25", madeAt: "2026-11-26T07:02:00Z", final: true, masking: "masked" as const, first: rows[0]!, count: 2, sums: {} };
function build(s: ReportSpec) {
  const r = rendererOf(s, new Set(["a:account_ref"]));
  const lines = linesOf(s, rows.map((d, i) => ({ ...renderRow(s, d, i, r), data: d })));
  return { lines, sheet: sheetOf(s, ctx) };
}
async function* once(l: Line[]) { yield l; }

describe("linesOf", () => {
  it("groups sorted by the real value with a subtotal each, then the total", () => {
    const s = design({ groups: ["recon:status"] });
    expect(build(s).lines.map((l) => [l.kind, l.cells[0]])).toEqual([
      ["group", "matched"], ["row", "R1"], ["subtotal", "Subtotal"], ["group", "unmatch"], ["row", "=SUM(1)"], ["subtotal", "Subtotal"], ["total", "Total"],
    ]);
  });
});

describe("writeCsvFile", () => {
  it("every section: header record, column headers, rows (numbers not neutralized, formulas are), total, footer line", async () => {
    const out = path.join(dir, "a.csv");
    const { lines, sheet } = build(design());
    const w = await writeCsvFile(once(lines), sheet, out);
    expect(readFileSync(out, "utf8").split("\r\n")).toEqual(["﻿Bank,PT Contoh", "Reference,Account,Amount", "R1,······5678,\"1.500,00\"", "'=SUM(1),,\"-25,00\"", "Total,,\"1.475,00\"", "End of file", ""]);
    expect(w.rows).toBe(2);
  });
  it("data only: just the rows; semicolons, LF and ASCII when asked (masking dots become *)", async () => {
    const out = path.join(dir, "b.csv");
    const s = dataOnly(design());
    const { lines, sheet } = build({ ...s, output: { ...s.output, csv: { delimiter: ";", quote: "auto" }, lineEnding: "lf", encoding: "ascii" } });
    await writeCsvFile(once(lines), sheet, out);
    expect(readFileSync(out, "utf8")).toBe("R1;******5678;1.500,00\n'=SUM(1);;-25,00\n");
  });
});

describe("writeTxt", () => {
  it("fixed width: header record, padded headers, zero-padded amounts with the sign first, cut values, total, footer", async () => {
    const out = path.join(dir, "a.txt");
    const s = design({}, 0, "none");
    const { lines, sheet } = build({ ...s, output: { ...s.output, format: "txt", lineEnding: "lf" } });
    await writeTxt(once(lines), sheet, out);
    expect(readFileSync(out, "utf8").split("\n")).toEqual([
      "Bank      PT Contoh", "Reference Account         Amount", "R1        ······5678000000001500", "=SUM(1)             -00000000025", "Total               000000001475", "End of file", "",
    ]);
  });
  it("data only: only data lines", async () => {
    const out = path.join(dir, "b.txt");
    const s = dataOnly(design({}, 0, "none"));
    const { lines, sheet } = build({ ...s, output: { ...s.output, format: "txt", lineEnding: "lf" } });
    await writeTxt(once(lines), sheet, out);
    expect(readFileSync(out, "utf8")).toBe("R1        ······5678000000001500\n=SUM(1)             -00000000025\n");
  });
});

describe("writeXlsx", () => {
  it("every section from A1: title, header lines, headers, rows (amounts as numbers), total, footer", async () => {
    const out = path.join(dir, "a.xlsx");
    const { lines, sheet } = build(design());
    await writeXlsx(once(lines), sheet, out);
    const ws = read(readFileSync(out)).Sheets.Report!;
    expect([ws.A1?.v, ws.A2?.v, ws.B2?.v, ws.A3?.v, ws.A4?.v, ws.C4?.v, ws.C4?.t, ws.A6?.v, ws.A7?.v]).toEqual(["Daily KSEI", "Bank", "PT Contoh", "Reference", "R1", 1500, "n", "Total", "End of file"]);
  });
  it("data only starts with the first row at A1", async () => {
    const out = path.join(dir, "b.xlsx");
    const { lines, sheet } = build(dataOnly(design()));
    await writeXlsx(once(lines), sheet, out);
    const ws = read(readFileSync(out)).Sheets.Report!;
    expect([ws.A1?.v, ws.A2?.v, ws.A3]).toEqual(["R1", "=SUM(1)", undefined]);
  });
});

describe("reportHtml", () => {
  it("every section; data only has no title, no header row and no footer; nothing outside is loaded", () => {
    const { lines, sheet } = build(design());
    const html = reportHtml(lines, sheet);
    expect(html).toContain("<h1>Daily KSEI</h1>");
    expect(html).toContain("<thead>");
    expect(html).toContain("End of file");
    expect(html).toContain("Final");
    expect(html).not.toMatch(/https?:\/\//);
    const d = build(dataOnly(design()));
    const bare = reportHtml(d.lines, d.sheet);
    expect(bare).not.toContain("<h1>");
    expect(bare).not.toContain("<thead>");
    expect(bare).not.toContain("<footer>");
    expect(bare).toContain("R1");
  });
});

describe("review fixes", () => {
  it("totals and header sums over customer data are blank in a masked file", () => {
    const s = design({ sections: { ...design().sections, header: { on: true, lines: [{ label: "Sum", value: { kind: "sum", ref: "a:amount_minor" } }] } } });
    const r = rendererOf(s, new Set(["a:amount_minor"]));
    const lines = linesOf(s, rows.map((d, i) => ({ ...renderRow(s, d, i, r), data: d })), undefined, r.masked ? r.customer : new Set());
    expect(lines.at(-1)!.cells).toEqual(["Total", "", ""]);
    const sheet = sheetOf(s, { ...ctx, sums: { "a:amount_minor": 1475 } }, undefined, new Set(["a:amount_minor"]));
    expect(sheet.header).toEqual([{ label: "Sum", value: "" }]);
  });
  it("a header sum is written in its column's format", () => {
    const s = design({ sections: { ...design().sections, header: { on: true, lines: [{ label: "Sum", value: { kind: "sum", ref: "a:amount_minor" } }] } } });
    expect(sheetOf(s, { ...ctx, sums: { "a:amount_minor": 150.1 + 20.2 } }).header).toEqual([{ label: "Sum", value: "170,30" }]);
  });
  it("ASCII Text keeps every line at its width (a dropped character doesn't shift the next columns)", async () => {
    const out = path.join(dir, "c.txt");
    const s = dataOnly(design({}, 0, "none"));
    const spec2 = { ...s, columns: [{ ...s.columns[0]!, layout: { align: "l" as const, width: 20, pad: " " as const } }], output: { ...s.output, format: "txt" as const, lineEnding: "lf" as const, encoding: "ascii" as const } };
    const r = rendererOf(spec2, new Set());
    const d = { date: "2026-11-25", values: { "a:ext_ref": "Kopi ☕ Senja" } };
    await writeTxt(once(linesOf(spec2, [{ ...renderRow(spec2, d, 0, r), data: d }])), sheetOf(spec2, ctx), out);
    expect(readFileSync(out, "utf8")).toBe("Kopi  Senja         \n");
  });
});

describe("summary only", () => {
  it("one line per group: the group's value in its column, sums and counts in theirs, then the total", () => {
    const s: ReportSpec = { ...design(), groups: ["recon:status"], summaryOnly: true,
      columns: [columnFor("c1", "recon:status", "Status"), { ...columnFor("c2", "a:ext_ref", "Rows"), format: { kind: "auto" } }, amount(2, ".")],
      totals: { on: true, perGroup: true, columns: { c2: "count", c3: "sum" } } };
    const r = rendererOf(s, new Set());
    const lines = linesOf(s, rows.map((d, i) => ({ ...renderRow(s, d, i, r), data: d })));
    expect(lines.map((l) => [l.kind, ...l.cells])).toEqual([["row", "matched", "1", "1.500,00"], ["row", "unmatch", "1", "-25,00"], ["total", "Total", "2", "1.475,00"]]);
  });
});
