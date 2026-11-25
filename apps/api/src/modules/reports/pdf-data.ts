// What a PDF shows for each kind of report (pdf-html.ts lays it out).
import type { ReportSpec } from "@starterkit/shared/contracts/reports";
import type { PdfData } from "./pdf-html";
import { dailySummary, groupRows, type ReportRow } from "./summary";

const TOTAL_LABEL = { count: "Count", sum: "Sum", min: "Min", max: "Max" } as const;

export function pdfData(spec: ReportSpec, rows: ReportRow[]): PdfData {
  if (spec.kind === "daily_summary") return { kind: "daily_summary", days: dailySummary(rows) };
  if (spec.kind === "grouped") return { kind: "grouped", columns: spec.columns, shaped: groupRows(rows, spec.groups, spec.totals), totals: spec.totals.map((t) => TOTAL_LABEL[t.fn]) };
  return { kind: "transactions", columns: spec.columns, rows };
}
