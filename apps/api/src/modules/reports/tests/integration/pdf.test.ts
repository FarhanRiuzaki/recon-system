// The PDF writer with a real Chromium (skipped where none is installed: REPORT_CHROMIUM_PATH, else Chrome on the host).
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { columnFor, emptySpec } from "@starterkit/shared/report-spec";
import { linesOf, sheetOf } from "../../lines";
import { renderRow, rendererOf } from "../../cells";
import { reportHtml } from "../../pdf-html";
import { writePdf } from "../../write-pdf";

const exe = [process.env.REPORT_CHROMIUM_PATH, "/usr/bin/chromium", "/usr/bin/google-chrome"].find((p) => p && existsSync(p));
const dir = mkdtempSync(path.join(tmpdir(), "reports-pdf-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!exe)("writePdf", () => {
  it("prints a design to a PDF", async () => {
    const s = { ...emptySpec(), columns: [columnFor("c1", "a:ext_ref", "Reference"), columnFor("c2", "a:amount_minor", "Amount")] };
    const rr = rendererOf(s, new Set());
    const d = { date: "2026-11-02", values: { "a:ext_ref": "R1", "a:amount_minor": 100 } };
    const html = reportHtml(linesOf(s, [{ ...renderRow(s, d, 0, rr), data: d }]), sheetOf(s, { recon: "KSEI", template: "Daily", from: "2026-11-02", to: "2026-11-02", madeAt: "2026-11-02T00:00:00Z", final: true, masking: "masked", first: d, count: 1, sums: {} }));
    const out = path.join(dir, "a.pdf");
    const r = await writePdf(html, out, exe!);
    expect(readFileSync(out).subarray(0, 4).toString()).toBe("%PDF");
    expect(r.size).toBeGreaterThan(1000);
  }, 60_000);
});
