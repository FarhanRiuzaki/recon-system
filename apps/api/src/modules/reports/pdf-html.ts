// A report's HTML printed to PDF by headless Chromium (owner's choice A, DEC-060): the design system's light tokens
// (packages/ui/src/styles/tokens.css, read as text), Inter bundled as a data URL, nothing fetched from anywhere. The
// sections of the design (spec 2026-11-26), each only when on: title, header block, the table (its header row repeated
// on every page), group lines, totals, and the footer with its text and stamp.
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Line, Sheet } from "./lines";

/** The light theme's custom properties (the `:root` block of tokens.css), read once. */
let tokens: string | null = null;
function lightTokens(): string {
  if (tokens !== null) return tokens;
  const css = readFileSync(path.join(import.meta.dir, "../../../../../packages/ui/src/styles/tokens.css"), "utf8");
  const start = css.indexOf(":root {");
  const end = css.indexOf("\n}", start);
  tokens = start >= 0 && end > start ? css.slice(start, end + 2) : "";
  return tokens;
}
let font: string | null = null;
const inter = () => (font ??= readFileSync(path.join(import.meta.dir, "assets/inter-latin-wght-normal.woff2")).toString("base64"));

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const ALIGN = { l: "left", c: "center", r: "right" } as const;

/** The whole page of `lines` in `sheet`'s frame. */
export function reportHtml(lines: Line[], sheet: Sheet): string {
  const td = (l: Line, i: number) => `<td style="text-align:${ALIGN[sheet.layouts[i]?.align ?? "l"]}"${l.marks[i] === "red" ? ' class="red"' : ""}>${esc(l.cells[i] ?? "")}</td>`;
  const body = lines.map((l) => `<tr class="${l.kind}">${l.cells.map((_, i) => td(l, i)).join("")}</tr>`).join("");
  const head = sheet.columnHeaders ? `<thead><tr>${sheet.headers.map((h, i) => `<th style="text-align:${ALIGN[sheet.layouts[i]?.align ?? "l"]}">${esc(h)}</th>`).join("")}</tr></thead>` : "";
  const header = sheet.header ? `<div class="meta">${sheet.header.map((h) => `<div><span>${esc(h.label)}</span> ${esc(h.value)}</div>`).join("")}</div>` : "";
  const foot = sheet.footer ? `<footer>${esc([sheet.footer.text, sheet.footer.stamp].filter(Boolean).join(" · "))}</footer>` : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(sheet.title ?? "Report")}</title><style>
@font-face { font-family: Inter; src: url(data:font/woff2;base64,${inter()}) format("woff2"); font-weight: 100 900; }
${lightTokens()}
* { box-sizing: border-box; }
body { margin: 0; font: 9.5pt/1.45 Inter, sans-serif; color: var(--fg); background: var(--card); }
h1 { font-size: 16pt; font-weight: 600; margin: 0 0 8pt; }
.meta { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2pt 14pt; margin-bottom: 12pt; color: var(--fg-2); } .meta span { color: var(--fg-3); }
table { width: 100%; border-collapse: collapse; } thead { display: table-header-group; } tr { break-inside: avoid; }
th { font-weight: 500; color: var(--fg-3); border-bottom: 1px solid var(--line-strong); padding: 4pt 6pt; }
td { border-bottom: 1px solid var(--line); padding: 4pt 6pt; vertical-align: top; font-variant-numeric: tabular-nums; }
tr.group td { background: var(--tray); font-weight: 600; } tr.subtotal td, tr.total td { font-weight: 600; border-top: 1px solid var(--line-strong); }
td.red { color: var(--down-ink); font-weight: 600; }
footer { position: fixed; bottom: 0; left: 0; right: 0; font-size: 8pt; color: var(--fg-3); }
</style></head><body>
${sheet.title ? `<h1>${esc(sheet.title)}</h1>` : ""}${header}
<table>${head}<tbody>${body}</tbody></table>
${foot}
</body></html>`;
}
