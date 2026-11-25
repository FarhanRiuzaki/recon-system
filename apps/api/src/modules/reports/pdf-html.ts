// A report as the HTML page Chromium prints (owner's choice A, DEC-060): the design system's light tokens
// (packages/ui/src/styles/tokens.css, read as text), Inter bundled as a data URL, nothing fetched from anywhere. The
// API may not import the React components (AGENTS.md §1), so each content kind is laid out here in the same arrangement
// as the screens: stat tiles and a breakdown for the daily summary, a table with its header repeated on every page for
// rows. Every page carries the stamp (Final / Not final, masked or full customer data) in its fixed footer.
import { readFileSync } from "node:fs";
import path from "node:path";
import { CURRENCY_EXPONENT } from "@starterkit/shared/sources";
import { RESULT_STATUS_LABEL } from "@starterkit/shared/results";
import { formatMinor, formatNumber, formatPercent } from "@starterkit/ui/lib/format";
import type { DaySummary, ReportRow, ShapedRow } from "./summary";
import type { Column } from "./write-csv";

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
const money = (v: bigint, ccy: string) => `${ccy} ${formatMinor(v, CURRENCY_EXPONENT[ccy] ?? 2)}`;

export type PdfData =
  | { kind: "transactions"; columns: Column[]; rows: ReportRow[] }
  | { kind: "grouped"; columns: Column[]; shaped: ShapedRow[]; totals: string[] }
  | { kind: "daily_summary"; days: DaySummary[] };
export type PdfMeta = { title: string; subtitle?: string; recon: string; from: string; to: string; dates: { date: string; final: boolean }[]; masking: "masked" | "full" };

function table(columns: Column[], body: string): string {
  return `<table><thead><tr>${columns.map((c) => `<th>${esc(c.header)}</th>`).join("")}</tr></thead><tbody>${body}</tbody></table>`;
}
const cells = (columns: Column[], r: ReportRow) => `<tr>${columns.map((c) => `<td>${esc(r.values[c.key] ?? "")}</td>`).join("")}</tr>`;

function daySection(d: DaySummary): string {
  const tiles = [["Results", formatNumber(d.total)], ["Matched", formatNumber(d.matched)], ["Breaks", formatNumber(d.breaks)], ["Match rate", d.matchRate === null ? "—" : formatPercent(d.matchRate, 1)]];
  const statuses = Object.entries(d.byStatus).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...statuses.map(([, n]) => n));
  return `<section class="day"><h2>${esc(d.date)}</h2>
    <div class="tiles">${tiles.map(([k, v]) => `<div class="tile"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("")}</div>
    <div class="card"><h3>Results by status</h3>${statuses.map(([s, n], i) => `<div class="bar"><span>${esc(RESULT_STATUS_LABEL[s as keyof typeof RESULT_STATUS_LABEL] ?? s)}</span><i style="width:${(n / max) * 100}%;background:var(--chart-${(i % 6) + 1})"></i><b>${formatNumber(n)}</b></div>`).join("")}</div>
    ${d.amounts.length ? `<div class="card"><h3>Amounts</h3>${table([{ key: "c", header: "Currency" }, { key: "m", header: "Matched" }, { key: "b", header: "Breaks" }], d.amounts.map((a) => `<tr><td>${esc(a.currency)}</td><td>${esc(money(a.matched, a.currency))}</td><td>${esc(money(a.breaks, a.currency))}</td></tr>`).join(""))}</div>` : ""}
    ${d.breaksByReason.length ? `<div class="card"><h3>Breaks by reason</h3>${table([{ key: "r", header: "Reason" }, { key: "n", header: "Breaks" }], d.breaksByReason.map((r) => `<tr><td>${esc(r.reason)}</td><td>${formatNumber(r.count)}</td></tr>`).join(""))}</div>` : ""}
  </section>`;
}

/** The whole page: title, the stamp, then the content of its kind. */
export function reportHtml(data: PdfData, meta: PdfMeta): string {
  const final = meta.dates.length > 0 && meta.dates.every((d) => d.final);
  const open = meta.dates.filter((d) => !d.final).length;
  const stamp = `${final ? "Final" : `Not final (${open} of ${meta.dates.length} dates not signed off)`} · ${meta.masking === "masked" ? "Masked customer data" : "Full customer data"}`;
  const range = meta.from === meta.to ? meta.from : `${meta.from} – ${meta.to}`;
  const body = data.kind === "daily_summary" ? data.days.map(daySection).join("")
    : data.kind === "transactions" ? table(data.columns, data.rows.map((r) => cells(data.columns, r)).join(""))
    : table(data.columns, data.shaped.map((s) => s.kind === "row" ? cells(data.columns, s.row!)
      : `<tr class="${s.kind}"><td colspan="${Math.max(1, data.columns.length - data.totals.length)}">${"&nbsp;".repeat(s.level * 4)}${esc(s.label ?? "")}</td>${(s.totals ?? []).map((t, i) => `<td title="${esc(data.totals[i] ?? "")}">${t === null ? "" : formatNumber(t)}</td>`).join("")}</tr>`).join(""));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(meta.title)}</title><style>
@font-face { font-family: Inter; src: url(data:font/woff2;base64,${inter()}) format("woff2"); font-weight: 100 900; }
${lightTokens()}
* { box-sizing: border-box; }
body { margin: 0; font: 10pt/1.45 Inter, sans-serif; color: var(--fg); background: var(--card); }
header { margin-bottom: 14pt; } h1 { font-size: 16pt; font-weight: 600; margin: 0; } h2 { font-size: 12pt; font-weight: 600; margin: 14pt 0 8pt; } h3 { font-size: 10pt; font-weight: 600; margin: 0 0 6pt; }
.sub, .meta { color: var(--fg-2); } .meta { font-size: 9pt; }
.stamp { display: inline-block; margin-top: 6pt; padding: 2pt 6pt; border: 1px solid var(--line-strong); border-radius: 4pt; font-size: 8.5pt; color: var(--fg-2); }
table { width: 100%; border-collapse: collapse; } thead { display: table-header-group; } tr { break-inside: avoid; }
th { text-align: left; font-weight: 400; color: var(--fg-3); border-bottom: 1px solid var(--line-strong); padding: 4pt 6pt; }
td { border-bottom: 1px solid var(--line); padding: 4pt 6pt; vertical-align: top; }
tr.group td { background: var(--tray); font-weight: 600; } tr.total td { font-weight: 600; border-top: 1px solid var(--line-strong); }
.tiles { display: flex; gap: 8pt; margin-bottom: 8pt; } .tile { flex: 1; border: 1px solid var(--line); border-radius: 8pt; padding: 8pt; background: var(--sheet); }
.tile .k { color: var(--fg-3); font-size: 8.5pt; } .tile .v { font-size: 15pt; }
.card { border: 1px solid var(--line); border-radius: 8pt; padding: 8pt; margin-bottom: 8pt; break-inside: avoid; }
.bar { display: grid; grid-template-columns: 34% 1fr 50pt; align-items: center; gap: 6pt; margin: 3pt 0; } .bar i { display: block; height: 7pt; border-radius: 2pt; } .bar b { font-weight: 400; text-align: right; }
.day { break-after: page; } .day:last-child { break-after: auto; }
footer { position: fixed; bottom: 0; left: 0; right: 0; font-size: 8pt; color: var(--fg-3); }
</style></head><body>
<header><h1>${esc(meta.title)}</h1>${meta.subtitle ? `<div class="sub">${esc(meta.subtitle)}</div>` : ""}<div class="meta">${esc(meta.recon)} · ${esc(range)}</div><div class="stamp">${esc(stamp)}</div></header>
${body}
<footer>${esc(meta.recon)} · ${esc(range)} · ${esc(stamp)}</footer>
</body></html>`;
}
