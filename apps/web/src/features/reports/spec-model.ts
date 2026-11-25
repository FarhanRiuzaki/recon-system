// A report template draft as the Wizard edits it (pure): its five steps, what each still needs, and the edits.
import type { ReportSpec } from "@starterkit/shared/contracts/reports";
import type { ReportFormat, ReportKind } from "@starterkit/shared/reports";
import type { ResultStatus } from "@starterkit/shared/results";

/** The draft's steps (the recon setup's pattern): Content, Columns and groups, Output, Test, Review and submit. */
export const REPORT_STEPS = [
  { n: 1, label: "Content" }, { n: 2, label: "Columns and groups" }, { n: 3, label: "Output" }, { n: 4, label: "Test" }, { n: 5, label: "Review and submit" },
] as const;
export type ReportStep = (typeof REPORT_STEPS)[number]["n"];

/** What step `n` still needs, or null (the API's rules, said on the step). */
export function stepProblem(s: ReportSpec, n: ReportStep): string | null {
  if (n === 2) {
    if (s.kind !== "daily_summary" && !s.columns.length) return "Pick at least one column.";
    if (s.kind === "grouped" && !s.groups.length) return "Pick a column to group the rows by.";
  }
  if (n === 3 && !s.output.fileName.trim()) return "Name the file.";
  if (n === 5) {
    if (s.output.masking === "full" && !s.official) return "Full customer data needs an official report: turn on Official report, or mask it.";
    if (!s.when.afterRun && !s.when.onRequest) return "Make it after every run, on request, or both.";
  }
  return null;
}

/** The first step with a problem, or null (Submit's reason). */
export const firstProblem = (s: ReportSpec): { n: ReportStep; why: string } | null => {
  for (const { n } of REPORT_STEPS) { const why = stepProblem(s, n); if (why) return { n, why }; }
  return null;
};

export const withKind = (s: ReportSpec, kind: ReportKind): ReportSpec => ({ ...s, kind, groups: kind === "grouped" ? s.groups : [], totals: kind === "grouped" ? (s.totals.length ? s.totals : [{ fn: "count" }]) : [] });
export const withFormat = (s: ReportSpec, format: ReportFormat): ReportSpec => ({ ...s, output: { ...s.output, format } });
export const toggleStatus = (s: ReportSpec, st: ResultStatus): ReportSpec => ({
  ...s, rows: { ...s.rows, statuses: s.rows.statuses.includes(st) ? s.rows.statuses.filter((x) => x !== st) : [...s.rows.statuses, st] },
});
