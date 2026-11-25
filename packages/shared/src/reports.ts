// The report generator's vocabulary and limits, zod-free (client code imports it as values, AGENTS.md §9).

/** v1 report kinds: read only to convert a v1 stored spec (report-spec.ts fromV1). */
export const REPORT_KINDS = ["transactions", "grouped", "daily_summary"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
export const REPORT_FORMATS = ["csv", "xlsx", "txt", "pdf"] as const;
export type ReportFormat = (typeof REPORT_FORMATS)[number];
/** What a template reads (spec v2 "Template, data and ownership"): the recon's results, its items, or one row per date and currency. */
export const REPORT_DATASETS = ["results", "items", "recap"] as const;
export type ReportDataset = (typeof REPORT_DATASETS)[number];
/** The date patterns a column may use (spec v2, exactly these). */
export const DATE_PATTERNS = ["dd/MM/yyyy", "yyyy-MM-dd", "yyyyMMdd", "ddMMyyyy", "dd MMM yyyy", "dd-MM-yyyy", "MM/dd/yyyy"] as const;
export type DatePattern = (typeof DATE_PATTERNS)[number];
export const FILTER_OPS = ["is", "is_not", "any_of", "contains", "empty", "not_empty", "gt", "lt"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];
/** The recap dataset's fields (one row per business date and currency). */
export const RECAP_FIELDS = ["date", "currency", "results", "matched", "breaks", "match_rate", "count_a", "amount_a", "count_b", "amount_b"] as const;
export const REPORT_FILE_STATUSES = ["queued", "making", "ready", "failed", "removed"] as const;
export type ReportFileStatus = (typeof REPORT_FILE_STATUSES)[number];
export const REPORT_VERSION_STATUSES = ["draft", "waiting", "active", "superseded"] as const;
export type ReportVersionStatus = (typeof REPORT_VERSION_STATUSES)[number];
export const REPORT_TOTALS = ["count", "sum", "min", "max"] as const;

/** A file covers at most this many calendar days. */
export const REPORT_RANGE_MAX_DAYS = 92;
/** A PDF holds at most this many rows; more go to CSV or Excel. */
export const PDF_ROWS_MAX = 5000;
/** Excel's own limit of rows per sheet. */
export const XLSX_ROWS_MAX = 1048576;
export const REPORT_COLUMNS_MAX = 60;
export const REPORT_HEADER_LINES_MAX = 20;
export const REPORT_GROUPS_MAX = 3;
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
