// Designs the reports tests start from (v1's "Break detail" start, converted: the shape v1 tests were written for).
import type { ReportSpec } from "@starterkit/shared/contracts/reports";
import { fromV1 } from "@starterkit/shared/report-spec";

export const breakDetail = (): ReportSpec => fromV1({
  kind: "transactions", rows: { statuses: ["unmatch", "waiting_counterpart"], side: "both", reasons: [] },
  columns: [{ key: "recon:businessDate", header: "Business date" }, { key: "a:ext_ref", header: "Reference" }, { key: "a:amount_minor", header: "Amount" }, { key: "recon:reason", header: "Reason" }, { key: "recon:assignee", header: "Assignee" }],
  groups: [], totals: [], output: { format: "xlsx", fileName: "{recon}_{from}_{to}", masking: "masked" }, when: { afterRun: false, onRequest: true }, official: false,
});
