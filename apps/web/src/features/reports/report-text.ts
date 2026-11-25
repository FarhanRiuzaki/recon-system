// The report generator's words (copy guide: sentence case, what happened and what to do).
import { REPORT_RANGE_MAX_DAYS, type ReportFileStatus } from "@starterkit/shared/reports";

export const STATUS_LABEL: Record<ReportFileStatus, string> = { queued: "Queued", making: "Making", ready: "Ready", failed: "Failed", removed: "Removed" };

/** A file's state as its row says it: "Making… 62%" while made. */
export const statusText = (f: { status: ReportFileStatus; progress: number }) => (f.status === "making" ? `Making… ${f.progress}%` : STATUS_LABEL[f.status]);
/** Final = every date of the file was signed off when it was read (owner 25 Nov). */
export const finalText = (final: boolean) => (final ? "Final" : "Not final");

const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400_000) + 1;
/** Why a range can't be asked for, or null (the API's own rule and sentence). */
export function generateProblem(from: string, to: string): string | null {
  if (!from || !to) return "Pick the first and the last date.";
  if (to < from) return "The end date is before the start date.";
  if (days(from, to) > REPORT_RANGE_MAX_DAYS) return `A report covers at most ${REPORT_RANGE_MAX_DAYS} days. Pick a shorter range.`;
  return null;
}
/** The dialog's notice when some dates of the range aren't signed off. */
export const openDatesNotice = (n: number) => (n <= 0 ? null : `${n} of these dates ${n === 1 ? "isn't" : "aren't"} signed off yet: the report is marked Not final.`);

export const NEW_TEMPLATE_REASON = "Only a config maker of this space creates report templates.";
export const DATASET_TEXT = { results: "Results", items: "Every item", recap: "Daily recap" } as const;
export const FORMAT_LABEL = { csv: "CSV", xlsx: "Excel", txt: "Text (fixed width)", pdf: "PDF" } as const;
export const TEMPLATE_STATUS_LABEL = { draft: "Draft", waiting: "Waiting approval", active: "Active", retired: "Retired" } as const;

export const EDIT_DRAFT_REASON = "Only a config maker of this space edits a report template's draft.";

/** The Test's sample file line: a link once the worker made it, else what it is doing. */
export function sampleLine(s: { status: string; error: string | null } | undefined): { link: boolean; text: string } {
  if (s?.status === "ready") return { link: true, text: "Download sample file" };
  if (s?.status === "failed") return { link: false, text: `The sample file failed: ${s.error ?? "it stopped."}` };
  return { link: false, text: "Making the sample file…" };
}
