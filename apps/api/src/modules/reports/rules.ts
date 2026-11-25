// Pure rules of report templates: the filled drafts "New report template" starts from, and what a version needs before
// it can be sent (spec "New template", "Draft: Wizard, five steps").
import type { ReportSpec } from "@starterkit/shared/contracts/reports";
import type { ReportKind, ReportStart } from "@starterkit/shared/reports";

const base = (kind: ReportKind, format: ReportSpec["output"]["format"]): ReportSpec => ({
  kind, rows: { statuses: [], side: "both", reasons: [] }, columns: [], groups: [], totals: [],
  output: { format, fileName: "{recon}_{from}_{to}", masking: "masked" }, when: { afterRun: false, onRequest: true }, official: false,
});

/** The draft each starting point opens with (to change); `blank` = transactions to CSV with no column yet. */
export function startSpec(start: ReportStart): ReportSpec {
  switch (start) {
    case "daily_summary":
      return { ...base("daily_summary", "pdf"), when: { afterRun: true, onRequest: true }, output: { format: "pdf", fileName: "{recon}_{date}", masking: "masked", title: "Daily recap" } };
    case "break_detail":
      return {
        ...base("transactions", "xlsx"), rows: { statuses: ["break"], side: "both", reasons: [] },
        columns: [
          { key: "recon:businessDate", header: "Business date" }, { key: "a:ext_ref", header: "Reference" }, { key: "a:amount_minor", header: "Amount" },
          { key: "recon:reason", header: "Reason" }, { key: "recon:assignee", header: "Assignee" },
        ],
      };
    case "matched_list":
      return {
        ...base("transactions", "csv"), rows: { statuses: ["matched"], side: "both", reasons: [] },
        columns: [{ key: "recon:businessDate", header: "Business date" }, { key: "a:ext_ref", header: "Reference A" }, { key: "b:ext_ref", header: "Reference B" }, { key: "a:amount_minor", header: "Amount" }],
      };
    case "blank":
      return base("transactions", "csv");
  }
}

/** Why a version can't be sent yet, or null: a report that isn't a daily summary needs a column; a grouped one a group. */
export function sendProblem(s: ReportSpec): string | null {
  if (s.kind !== "daily_summary" && !s.columns.length) return "Pick at least one column.";
  if (s.kind === "grouped" && !s.groups.length) return "Pick a column to group the rows by.";
  return null;
}
