// Operation result as people read it (spec docs/superpowers/specs/2026-11-24-operation-result-design.md): each overall
// status and side state as an icon with its chip (tone by meaning, categories.ts), a cell's words. Pure.
import { appDayStart, formatDate, formatDateTime } from "@starterkit/ui/lib/format";
import type { IconData } from "@starterkit/ui/ui/icon";
import {
  AlertsIcon, ArrowRightIcon, CalendarIcon, CheckIcon, CloseIcon, EditIcon, NoneIcon, FailedIcon, ForceMatchIcon, SpinnerIcon, SuccessIcon, SuggestedIcon, TakeIcon, TimeIcon,
  WaitIcon, WarningIcon, WriteOffIcon,
} from "@starterkit/ui/ui/icons";
import type { ResultCell, ResultColumn, ResultSide } from "@starterkit/shared/contracts/results";
import { POSTING_STATUS_LABEL, type PostingStatus } from "@starterkit/shared/posting";
import { RESULT_STATUS_LABEL, type ResultStatus, type SideState } from "@starterkit/shared/results";
import { amountText } from "@/lib/shared/amount";
import { statusChip, type StatusChipData, type StatusMeaning } from "@/lib/shared/categories";

/** Each status's meaning (its tone) and icon: green done, red failed or unmatch, amber needs a look, blue under way, grey off (not required: a one-way recon's side B, A → B). */
const STATUS: Record<ResultStatus, readonly [StatusMeaning, IconData]> = {
  posting_failed: ["failed", FailedIcon], posting_in_progress: ["sending", SpinnerIcon], posting_skipped: ["check", WarningIcon],
  waiting_approval: ["waiting", WaitIcon], posted: ["posted", SuccessIcon], written_off: ["nothing", WriteOffIcon], adjusted: ["nothing", EditIcon],
  closed: ["off", CloseIcon], force_matched: ["matched", ForceMatchIcon], matched_by_hand: ["matched", TakeIcon], matched_late: ["matched", CalendarIcon],
  suggested: ["check", SuggestedIcon], matched: ["matched", CheckIcon], unmatch: ["missing", AlertsIcon], not_required: ["off", ArrowRightIcon],
  waiting_counterpart: ["open", TimeIcon],
};
export const resultIcon = (s: ResultStatus): { icon: IconData; chip: StatusChipData } => ({ icon: STATUS[s][1], chip: statusChip(STATUS[s][0], RESULT_STATUS_LABEL[s]) });

/** A side's state: its icon (✓ green in a group, ✕ red unmatch, … ) and words; the legend names each "Record …". */
const SIDE: Record<SideState, readonly [StatusMeaning, string, IconData]> = {
  in_group: ["matched", "Record matched", CheckIcon], suggested: ["check", "Record suggested", SuggestedIcon], unmatch: ["missing", "Record unmatched", CloseIcon], not_required: ["off", "Record not required", ArrowRightIcon],
  open: ["open", "Record waiting for a counterpart", TimeIcon], closed: ["off", "Record closed", WriteOffIcon], none: ["nothing", "No record on this side", NoneIcon],
};
export const SIDE_LABEL = Object.fromEntries(Object.entries(SIDE).map(([k, v]) => [k, v[1]])) as Record<SideState, string>;
/** A side's icon and chip (tone + words, for the legend and assistive tech); `count` = "3 records" when the side holds more than one. */
export function sideIcon(s: ResultSide): { icon: IconData; chip: StatusChipData; count: string | null } {
  const [meaning, label, icon] = SIDE[s.state];
  return { icon, chip: statusChip(meaning, label), count: s.count > 1 ? `${s.count} records` : null };
}
/** The sides as the table, the filters and Explain head them; the source's name sits behind (sideHelp). */
export const SIDE_HEADER = ["Side A", "Side B"] as const;
/** What a side's header explains (its ⓘ, by hover, focus or press): "Side A: <the side's label>". */
export const sideHelp = (i: 0 | 1, sides: readonly [string, string]) => `${SIDE_HEADER[i]}: ${sides[i]}`;

/** The card legend: every overall status, then every side state, each with the icon the table draws. */
export const RESULT_LEGEND = [
  ...(Object.keys(STATUS) as ResultStatus[]).map((s) => ({ ...resultIcon(s).chip, icon: resultIcon(s).icon })),
  ...(Object.keys(SIDE) as SideState[]).map((k) => ({ ...statusChip(SIDE[k][0], SIDE[k][1]), icon: SIDE[k][2] })),
];

/** The recon the page shows: `wanted` while it has a published version, else the first (by name) that has one; none = null. */
export function pickRecon(recons: readonly { id: string; publishedVersion: number | null }[], wanted: string | null): string | null {
  const live = recons.filter((r) => r.publishedVersion !== null);
  return (live.find((r) => r.id === wanted) ?? live[0])?.id ?? null;
}

/** FNV-1a of `s`, base 36: a short stable tag of a key cut to fit. */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}
/**
 * A column's DataTable key: one per field, in the shape the saved column choice keeps (prefs COLUMN_KEY, at most 40
 * characters); a longer one is cut and tagged with a hash of the whole, so two long fields never share a key.
 */
export function columnKey(c: Pick<ResultColumn, "kind" | "field">): string {
  const k = `${c.kind}-${c.field}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (k.length <= 40) return k;
  const tag = shortHash(`${c.kind}:${c.field}`);
  return `${k.slice(0, 39 - tag.length)}_${tag}`;
}

/**
 * What the page shows: `none` once the recon list says no recon has a published version, `error` when that list
 * failed and the URL names no recon (nothing to show but the failure), else the table (a recon from the URL is
 * trusted while the list loads or fails).
 */
export function pageState(recons: { loaded: boolean; failed: boolean; published: number }, configId: string | null): "none" | "error" | "table" {
  if (recons.loaded && !recons.published) return "none";
  if (recons.failed && !configId) return "error";
  return "table";
}
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
