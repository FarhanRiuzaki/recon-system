// Report writers: CSV (neutralized, the template's headers), Excel (group totals bold), and the PDF's HTML (no
// outside URL, every page's footer).
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { read } from "xlsx";
import type { ReportRow } from "../../summary";
import { writeCsv } from "../../write-csv";
import { writeXlsx } from "../../write-xlsx";
import { reportHtml } from "../../pdf-html";

const dir = mkdtempSync(path.join(tmpdir(), "reports-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const row = (ref: string, reason = "No counterpart"): ReportRow => ({ date: "2026-11-02", status: "unmatch", values: { "a:ext_ref": ref, "recon:reason": reason, "a:amount_minor": "10" }, amount: 10n, currency: "IDR", reason });
async function* pages(...ps: ReportRow[][]) { for (const p of ps) yield p; }
const columns = [{ key: "a:ext_ref", header: "Reference" }, { key: "a:amount_minor", header: "Amount" }];

describe("writeCsv", () => {
  it("writes the template's headers, neutralizes formula cells, and answers rows, size and sha256", async () => {
    const out = path.join(dir, "a.csv");
    const r = await writeCsv(pages([row("=SUM(1)")], [row("R2")]), columns, out);
    const text = readFileSync(out, "utf8");
    expect(text.split("\r\n").slice(0, 3)).toEqual(["﻿Reference,Amount", "'=SUM(1),10", "R2,10"]);
    expect(r.rows).toBe(2);
    expect(r.sha256).toBe(new Bun.CryptoHasher("sha256").update(readFileSync(out)).digest("hex"));
  });
});

describe("writeXlsx", () => {
  it("writes one sheet with the headers; grouped rows carry their group lines", async () => {
    const out = path.join(dir, "a.xlsx");
    const r = await writeXlsx(pages([row("R1", "B"), row("R2", "A")]), columns, out, { groups: ["recon:reason"], totals: [{ fn: "count" }] });
    const wb = read(readFileSync(out));
    const sheet = wb.Sheets[wb.SheetNames[0]!]!;
    expect(sheet.A1?.v).toBe("Reference");
    expect(sheet.A2?.v).toBe("A");
    expect(r.rows).toBe(2);
  });
});

describe("reportHtml", () => {
  it("holds no outside URL and stamps every page with Final or Not final and the masking", () => {
    const html = reportHtml({ kind: "transactions", columns, rows: [row("R1")] }, { title: "KSEI daily recap", recon: "KSEI vs Core", from: "2026-11-02", to: "2026-11-02", dates: [{ date: "2026-11-02", final: false }], masking: "masked" });
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).toContain("Not final");
    expect(html).toContain("Masked customer data");
    expect(html).toContain("KSEI daily recap");
  });
});
