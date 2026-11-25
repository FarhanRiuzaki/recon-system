// The report generator's vocabulary and limits, zod-free (client code imports it as values, AGENTS.md §9).

/** What a report holds: one row per item, rows grouped with totals, or one summary per recon per business date. */
export const REPORT_KINDS = ["transactions", "grouped", "daily_summary"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const REPORT_FORMATS = ["csv", "xlsx", "pdf"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];
/** The starting points "New report template" offers (filled drafts to change). */
export const REPORT_STARTS = ["daily_summary", "break_detail", "matched_list", "blank"] as const;
export type ReportStart = (typeof REPORT_STARTS)[number];
export const REPORT_FILE_STATUSES = ["queued", "making", "ready", "failed", "removed"] as const;
export type ReportFileStatus = (typeof REPORT_FILE_STATUSES)[number];
export const REPORT_VERSION_STATUSES = ["draft", "waiting", "active", "rejected", "superseded"] as const;
export type ReportVersionStatus = (typeof REPORT_VERSION_STATUSES)[number];
export const REPORT_TOTALS = ["count", "sum", "min", "max"] as const;

/** A file covers at most this many calendar days. */
export const REPORT_RANGE_MAX_DAYS = 92;
/** A PDF holds at most this many rows; more go to CSV or Excel. */
export const PDF_ROWS_MAX = 5000;
/** Excel's own limit of rows per sheet. */
export const XLSX_ROWS_MAX = 1048576;
export const REPORT_COLUMNS_MAX = 40;
export const REPORT_NAME_MAX = 120;

/**
 * A file's name from its template's pattern: `{recon}`, `{template}`, `{from}`, `{to}` and `{date}` (the one date, or
 * `from_to`); any other brace stays as its word. Only letters, digits, `.`, `_` and `-` remain (no folder, no space),
 * so a name never holds a path or a column value.
 */
export function fileNameOf(pattern: string, t: { recon: string; template: string; from: string; to: string }): string {
  const tokens: Record<string, string> = { recon: t.recon, template: t.template, from: t.from, to: t.to, date: t.from === t.to ? t.from : `${t.from}_${t.to}` };
  const filled = pattern.replace(/\{([a-z]+)\}/g, (_, k: string) => tokens[k] ?? k);
  return filled.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/^[-.]+|[-.]+$/g, "").slice(0, 150) || "report";
}
