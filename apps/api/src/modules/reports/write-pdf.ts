// A report's HTML printed to PDF by headless Chromium (owner's choice A, DEC-060). Only this file drives a browser
// (AGENTS.md §5): one browser per file, closed in `finally`; every request but the page itself is refused, so the
// page can't reach the network (it needs nothing: tokens and the font are inlined).
import { chromium } from "playwright-core";
import type { Written } from "./write-csv";

export async function writePdf(html: string, out: string, chromiumPath: string): Promise<Omit<Written, "rows">> {
  const browser = await chromium.launch({ executablePath: chromiumPath, headless: true, args: ["--disable-gpu", "--no-first-run", "--disable-extensions"] });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (r) => (r.request().url().startsWith("data:") ? r.continue() : r.abort()));
    await page.setContent(html, { waitUntil: "load" });
    const bytes = await page.pdf({
      format: "A4", landscape: true, printBackground: true, margin: { top: "14mm", bottom: "16mm", left: "12mm", right: "12mm" },
      displayHeaderFooter: true, headerTemplate: "<span></span>",
      footerTemplate: '<div style="font: 8px sans-serif; width: 100%; text-align: right; padding-right: 12mm; color: #636b7c">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
    });
    await Bun.write(out, bytes);
    return { size: bytes.length, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
  } finally {
    await browser.close();
  }
}
