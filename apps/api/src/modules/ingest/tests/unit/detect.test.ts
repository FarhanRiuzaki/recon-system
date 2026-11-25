// Detection (detect.ts): how a sample is read, one fixture per shape of file.
import { describe, expect, it } from "bun:test";
import * as XLSX from "xlsx";
import { detect, sampleOfFile, sniffKind } from "../../detect";
import { KSEI_FILE } from "./fixtures";

const enc = (s: string) => new TextEncoder().encode(s);
const sample = (b: Uint8Array | string, name = "x.txt") => { const head = typeof b === "string" ? enc(b) : b; return { head, tail: null, size: head.length, name }; };
const ok = (r: ReturnType<typeof detect>) => { if (!r.supported) throw new Error(`not supported: ${r.reason}`); return r; };

describe("sniffKind", () => {
  it("names what it can't read; text and workbooks pass", () => {
    expect(sniffKind(enc("%PDF-1.7\n"))).toEqual({ unsupported: "PDF" });
    expect(sniffKind(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toEqual({ unsupported: "Image" });
    expect(sniffKind(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]))).toEqual({ unsupported: "ZIP" });
    expect(sniffKind(new Uint8Array([0, 1, 2, 3, 0, 0, 5, 0, 0, 9, 0, 0]))).toEqual({ unsupported: "Binary" });
    expect(sniffKind(enc("a|b\n"))).toBe("text");
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["a"]]), "S");
    expect(sniffKind(new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer))).toBe("xlsx");
    expect(sniffKind(new Uint8Array(XLSX.write(wb, { type: "array", bookType: "biff8" }) as ArrayBuffer))).toBe("xls");
  });
});

describe("detect: text", () => {
  it("KSEI ACT: pipe, no header, high on whole lines; one broken line makes it low", () => {
    const clean = KSEI_FILE.split("\n").filter((l) => l.split("|").length === 14).join("\n") + "\n";
    expect(ok(detect(sample(KSEI_FILE))).confidence).toBe("low");
    const r = ok(detect(sample(clean, "act20261102.txt")));
    expect(r.format).toMatchObject({ kind: "delimited", delimiter: "|", header: false });
    expect(r.confidence).toBe("high");
    expect(r.columns[0]).toBe("col_01");
  });

  it("a semicolon CSV with a byte order mark and a header", () => {
    const r = ok(detect(sample(new Uint8Array([0xef, 0xbb, 0xbf, ...enc("ref;date;amount\nA1;2026-11-25;100,50\nA2;2026-11-25;7\nA3;2026-11-26;12\n")]))));
    expect(r.format).toMatchObject({ kind: "delimited", delimiter: ";", header: true, encoding: "utf-8" });
    expect(r.columns).toEqual(["ref", "date", "amount"]);
  });

  it("a report: title lines above, a total line below", () => {
    const text = "BANK MEGA\nLaporan Transaksi\nTanggal 25-11-2026\nref,date,amount\nA1,2026-11-25,100\nA2,2026-11-25,200\nA3,2026-11-25,300\nTotal,,600\n";
    const r = ok(detect(sample(text)));
    expect(r.format).toMatchObject({ kind: "delimited", delimiter: ",", header: true, skip_top: 3, skip_bottom: 1 });
    expect(r.rows.map((x) => x.role)).toEqual(["skipped", "skipped", "skipped", "header", "detail", "detail", "detail", "skipped"]);
  });

  it("fixed-length lines: columns where the spaces line up", () => {
    const text = ["0001ABC       0000150000", "0002DEFGH     0000025000", "0003XY        0000999900", "0004LONGNAME  0000000100"].join("\n") + "\n";
    const r = ok(detect(sample(text)));
    expect(r.format.kind).toBe("fixed_width");
    expect((r.format as { columns: { start: number; length: number }[] }).columns).toEqual([{ start: 1, length: 4 }, { start: 5, length: 10 }, { start: 15, length: 10 }]);
  });

  it("header and detail lines with a trailer: record types by the first cell", () => {
    const text = "H|MERCH01|20261125\nD|TRX001|100000\nD|TRX002|250000\nH|MERCH02|20261125\nD|TRX003|50000\nT|3|400000\n";
    const r = ok(detect(sample(text)));
    expect(r.format).toMatchObject({ kind: "delimited", delimiter: "|", header: false, records: { marker: { kind: "column", index: 0 }, types: [
      { code: "D", role: "detail", count: 3 }, { code: "H", role: "header", count: 3 }, { code: "T", role: "skip", count: 3 },
    ] } });
    expect(r.columns).toEqual(["hdr_01", "hdr_02", "hdr_03", "col_01", "col_02", "col_03"]);
    expect(r.rows.map((x) => x.role)).toEqual(["record_header", "detail", "detail", "record_header", "detail", "trailer"]);
  });

  it("ragged text with no shape: it says it can't read it and keeps a starting guess", () => {
    const r = ok(detect(sample("hello world\nthis is, a; note|\nnothing lines up here at all\nx\n")));
    expect(r.confidence).toBe("none");
    expect(r.notes.length).toBeGreaterThan(0);
  });
});

describe("detect: Excel and the rest", () => {
  it("a workbook: the sheet with the most rows, its title skipped", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Summary"], ["total", 2]]), "Summary");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["ACT report"], ["ref", "amount"], ["A1", 1], ["A2", 2], ["A3", 3]]), "ACT 25-11");
    const r = ok(detect(sample(new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }) as ArrayBuffer), "act.xlsx")));
    expect(r.format).toEqual({ kind: "excel", sheet: { kind: "name", name: "ACT 25-11" }, header: true, skip_top: 1 });
    expect(r.columns).toEqual(["ref", "amount"]);
  });

  it("a PDF is not supported, by name", () => {
    expect(detect(sample(enc("%PDF-1.7 ..."), "laporan.pdf"))).toEqual({ supported: false, fileName: "laporan.pdf", type: "PDF", reason: "PDF files aren't supported yet. Ask the sender for CSV, TXT or Excel." });
  });
});

describe("review 25 Nov", () => {
  it("a debit/credit first column is data, not record types", () => {
    const text = Array.from({ length: 12 }, (_, i) => `${i % 3 ? "D" : "C"},2026112${i % 9},${1000 + i},ACC${i}`).join("\n") + "\n";
    const r = ok(detect(sample(text)));
    expect(r.format).toMatchObject({ kind: "delimited", delimiter: "," });
    expect((r.format as { records?: unknown }).records).toBeUndefined();
  });
  it("a compressed workbook over 1 MB is detected from a file, not cut as text", async () => {
    const { utils, write } = await import("xlsx");
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const rows = [["ref", "name", "amount"], ...Array.from({ length: 30000 }, (_, i) => [`R${i}`, Math.random().toString(36).repeat(3), i])];
    const wb = utils.book_new(); utils.book_append_sheet(wb, utils.aoa_to_sheet(rows), "ACT");
    const bytes = new Uint8Array(write(wb, { type: "array", bookType: "xlsx", compression: true }) as ArrayBuffer);
    expect(bytes.length).toBeGreaterThan(1024 * 1024);
    const d = mkdtempSync(path.join(tmpdir(), "det-"));
    try {
      writeFileSync(path.join(d, "big.xlsx"), bytes);
      const r = ok(detect(await sampleOfFile(path.join(d, "big.xlsx"), "big.xlsx", 50)));
      expect(r.format).toMatchObject({ kind: "excel", header: true });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
  it("a workbook over the limit, or one that can't be opened, is an outcome, not an error", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const path = await import("node:path");
    const d = mkdtempSync(path.join(tmpdir(), "det-"));
    try {
      const fake = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode("xxxxxxxxxxxxxxxxxxxxxxxxxx xl/workbook.xml broken")]);
      writeFileSync(path.join(d, "bad.xlsx"), fake);
      expect(detect(await sampleOfFile(path.join(d, "bad.xlsx"), "bad.xlsx", 50))).toMatchObject({ supported: false, type: "Excel" });
      writeFileSync(path.join(d, "huge.xlsx"), new Uint8Array([...fake, ...new Uint8Array(2 * 1024 * 1024)]));
      expect(detect(await sampleOfFile(path.join(d, "huge.xlsx"), "huge.xlsx", 1))).toMatchObject({ supported: false, reason: "The workbook is over 1 MB. Ask the sender for a smaller file or CSV." });
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
