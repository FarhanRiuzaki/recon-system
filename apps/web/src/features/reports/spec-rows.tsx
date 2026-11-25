// A version's settings as label / value rows (the template's Overview and its version page).
import type { ReportSpec } from "@starterkit/shared/contracts/reports";
import { RESULT_STATUS_LABEL } from "@starterkit/shared/results";
import { ValueRows } from "@/components/version-layout";
import { FORMAT_LABEL, KIND_LABEL } from "./report-text";

export function SpecRows({ spec }: { spec: ReportSpec }) {
  return <ValueRows items={[
    ["Holds", KIND_LABEL[spec.kind]],
    ["Rows", spec.rows.statuses.length ? spec.rows.statuses.map((s) => RESULT_STATUS_LABEL[s]).join(", ") : "Every result"],
    ["Columns", spec.kind === "daily_summary" ? "Results, matched, breaks, match rate per date" : spec.columns.map((c) => c.header).join(", ") || "None yet"],
    ...(spec.kind === "grouped" ? [["Grouped by", spec.groups.join(", ") || "None yet"] as const] : []),
    ["File", `${FORMAT_LABEL[spec.output.format]} · ${spec.output.fileName}`],
    ["Customer data", spec.output.masking === "full" ? "Full (official report)" : "Masked"],
    ["Made", [spec.when.afterRun && "After every run", spec.when.onRequest && "On request"].filter(Boolean).join(" and ")],
    ["Official report", spec.official ? "Yes: a config checker approves each version" : "No"],
  ]} />;
}
