// Operation result as people read it (spec docs/superpowers/specs/2026-11-24-operation-result-design.md): each overall
// status and side state as an icon with its chip (tone by meaning, categories.ts), a cell's words. Pure.
import { appDayStart, formatDate, formatDateTime } from "@starterkit/ui/lib/format";
import type { IconData } from "@starterkit/ui/ui/icon";
import {
  AlertsIcon, CalendarIcon, CheckIcon, CloseIcon, EditIcon, FailedIcon, ForceMatchIcon, SpinnerIcon, SuccessIcon, SuggestedIcon, TakeIcon, TimeIcon,
  WaitIcon, WarningIcon, WriteOffIcon,
} from "@starterkit/ui/ui/icons";
import type { ResultCell, ResultColumn, ResultSide } from "@starterkit/shared/contracts/results";
import { POSTING_STATUS_LABEL, type PostingStatus } from "@starterkit/shared/posting";
import { RESULT_STATUS_LABEL, type ResultStatus, type SideState } from "@starterkit/shared/results";
import { amountText } from "@/lib/shared/amount";
import { statusChip, type StatusChipData, type StatusMeaning } from "@/lib/shared/categories";

/** Each status's meaning (its tone) and icon: green done, red failed or unmatch, amber needs a look, blue under way, grey off. */
const STATUS: Record<ResultStatus, readonly [StatusMeaning, IconData]> = {
  posting_failed: ["failed", FailedIcon], posting_in_progress: ["sending", SpinnerIcon], posting_skipped: ["check", WarningIcon],
  waiting_approval: ["waiting", WaitIcon], posted: ["posted", SuccessIcon], written_off: ["nothing", WriteOffIcon], adjusted: ["nothing", EditIcon],
  closed: ["off", CloseIcon], force_matched: ["matched", ForceMatchIcon], matched_by_hand: ["matched", TakeIcon], matched_late: ["matched", CalendarIcon],
  suggested: ["check", SuggestedIcon], matched: ["matched", CheckIcon], unmatch: ["missing", AlertsIcon], waiting_counterpart: ["open", TimeIcon],
};
export const resultIcon = (s: ResultStatus): { icon: IconData; chip: StatusChipData } => ({ icon: STATUS[s][1], chip: statusChip(STATUS[s][0], RESULT_STATUS_LABEL[s]) });

const SIDE: Record<SideState, readonly [StatusMeaning, string]> = {
  in_group: ["matched", "Matched"], suggested: ["check", "Suggested"], unmatch: ["missing", "Unmatch"],
  open: ["open", "Waiting"], closed: ["off", "Closed"], none: ["nothing", "No record"],
};
export const SIDE_LABEL = Object.fromEntries(Object.entries(SIDE).map(([k, v]) => [k, v[1]])) as Record<SideState, string>;
/** A side's chip (its shape and tone tell the state); `count` = "3 records" when the side holds more than one. */
export function sideIcon(s: ResultSide): { chip: StatusChipData; count: string | null } {
  const [meaning, label] = SIDE[s.state];
  return { chip: statusChip(meaning, label), count: s.count > 1 ? `${s.count} records` : null };
}

/** The recon the page shows: `wanted` while it has a published version, else the first (by name) that has one; none = null. */
export function pickRecon(recons: readonly { id: string; publishedVersion: number | null }[], wanted: string | null): string | null {
  const live = recons.filter((r) => r.publishedVersion !== null);
  return (live.find((r) => r.id === wanted) ?? live[0])?.id ?? null;
}

/** A column's DataTable key: one per field, in the shape the saved column choice keeps (prefs COLUMN_KEY). */
export const columnKey = (c: Pick<ResultColumn, "kind" | "field">) => `${c.kind}-${c.field}`.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
/** A cell's key in a row's `cells` (the API's). */
export const cellKey = (c: Pick<ResultColumn, "kind" | "field">) => `${c.kind}:${c.field}`;

export const MISSING_TEXT = "Field not in the source";
/** A cell as text: a lost field, "3 values" when the side's records differ, an amount in its currency, recon info in words. */
export function cellText(cell: ResultCell | undefined, c: ResultColumn): string {
  if (cell?.missing) return MISSING_TEXT;
  if (cell?.many) return `${cell.many} values`;
  const v = cell?.value ?? null;
  if (v === null) return "–";
  if (c.kind !== "recon") {
    if (c.field === "amount_minor") return v === "Mixed" || !/^-?\d+$/.test(v) ? v : `${amountText(v, cell?.currency ?? null)}${cell?.currency ? ` ${cell.currency}` : ""}`;
    if (c.field === "business_date" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return formatDate(appDayStart(v));
    if (c.field === "event_time" && !Number.isNaN(Date.parse(v))) return formatDateTime(Date.parse(v));
    return v;
  }
  if (c.field === "businessDate") return formatDate(appDayStart(v));
  if (c.field === "resolvedAt") return formatDateTime(Date.parse(v));
  if (c.field === "postingStatus") return POSTING_STATUS_LABEL[v as PostingStatus] ?? v;
  if (c.field === "pass") return `Pass ${v}`;
  return v;
}
