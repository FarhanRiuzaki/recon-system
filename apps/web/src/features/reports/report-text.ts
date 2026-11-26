// The report generator's words (copy guide: sentence case, what happened and what to do).
import { REPORT_RANGE_MAX_DAYS, type ReportFileStatus } from "@starterkit/shared/reports";
import { appDayStart, formatDate } from "@starterkit/ui/lib/format";

/** A calendar date ("2026-11-25") in the app's format with its year: "25 Nov 2026". */
export const dayText = (d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${formatDate(appDayStart(d))} ${d.slice(0, 4)}` : "–");
/** A file's dates: one day, or "1 Nov 2026 – 25 Nov 2026". */
export const datesText = (from: string, to: string) => (from === to ? dayText(from) : `${dayText(from)} – ${dayText(to)}`);

/** "creditor_bank" / "businessDate" → "Creditor bank" / "Business date". */
const words = (name: string) => { const s = name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_.]+/g, " ").trim().toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); };
/** What a field ref is called on screen: its label in the data, else its name in words (a field the data lacks). */
export function refLabel(ref: string, fields: ReadonlyMap<string, { label: string }>): string {
  const known = fields.get(ref)?.label;
  if (known) return known;
  const name = ref.replace(/^[a-z]+:/, "").replace(/^attrs\./, "");
  return name ? words(name) : "A field";
}

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

/** A template version's state, the same words on the template page and the version page. */
export const VERSION_STATUS_LABEL = { draft: "Draft", waiting: "Waiting for approval", active: "Active", superseded: "Superseded" } as const;

export const EDIT_DRAFT_REASON = "Only a config maker of this space edits a report template's draft.";

/** The Test's sample file line: a link once the worker made it, else what it is doing. */
export function sampleLine(s: { status: string; error: string | null } | undefined): { link: boolean; text: string } {
  if (s?.status === "ready") return { link: true, text: "Download sample file" };
  if (s?.status === "failed") return { link: false, text: `The sample file failed: ${s.error ?? "it stopped."}` };
  return { link: false, text: "Making the sample file…" };
}
