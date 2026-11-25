// The PDF writer with a real Chromium (skipped where none is installed: REPORT_CHROMIUM_PATH, else Chrome on the host).
import { afterAll, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { reportHtml } from "../../pdf-html";
import { writePdf } from "../../write-pdf";

const exe = [process.env.REPORT_CHROMIUM_PATH, "/usr/bin/chromium", "/usr/bin/google-chrome"].find((p) => p && existsSync(p));
const dir = mkdtempSync(path.join(tmpdir(), "reports-pdf-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!exe)("writePdf", () => {
  it("prints the daily summary to a PDF", async () => {
    const html = reportHtml({ kind: "daily_summary", days: [{ date: "2026-11-02", total: 3, byStatus: { matched: 2, unmatch: 1 }, matched: 2, breaks: 1, matchRate: 2 / 3, amounts: [{ currency: "IDR", matched: 10000n, breaks: 500n }], breaksByReason: [{ reason: "No counterpart", count: 1 }] }] },
      { title: "Daily recap", recon: "KSEI vs Core", from: "2026-11-02", to: "2026-11-02", dates: [{ date: "2026-11-02", final: true }], masking: "masked" });
    const out = path.join(dir, "a.pdf");
    const r = await writePdf(html, out, exe!);
    expect(readFileSync(out).subarray(0, 4).toString()).toBe("%PDF");
    expect(r.size).toBeGreaterThan(1000);
  }, 60_000);
});
