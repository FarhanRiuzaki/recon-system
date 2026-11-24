// Operation result (spec docs/superpowers/specs/2026-11-24-operation-result-design.md): one row per result of a recon
// (a match group, or an item no live group holds), its overall status and each side's state. zod-free: the screen
// imports these as values; the API computes the same order in SQL (engine results.ts) and a test checks both agree.
import type { BREAK_ACTION_STATUSES } from "./contracts/breaks";
import type { GroupKind, ItemStatus, Resolution } from "./recon";

/** Overall statuses in the spec table's order: a row takes the first that holds. */
export const RESULT_STATUSES = [
  "posting_failed", "posting_in_progress", "posting_skipped", "waiting_approval", "posted", "written_off", "adjusted", "closed",
  "force_matched", "matched_by_hand", "matched_late", "suggested", "matched", "unmatch", "not_required", "waiting_counterpart",
] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];
export const RESULT_STATUS_LABEL: Record<ResultStatus, string> = {
  posting_failed: "Posting failed", posting_in_progress: "Posting in progress", posting_skipped: "Posting skipped", waiting_approval: "Waiting approval",
  posted: "Posted", written_off: "Written off", adjusted: "Adjusted", closed: "Closed", force_matched: "Force matched", matched_by_hand: "Matched by hand",
  matched_late: "Matched late", suggested: "Suggested", matched: "Matched", unmatch: "Unmatch", not_required: "Not required", waiting_counterpart: "Waiting for counterpart",
};

/** A side of a row: its records are in the group (or a suggested one), an unmatch item, not required (one-way, DEC-055), open, closed, or none of that side. */
export const SIDE_STATES = ["in_group", "suggested", "unmatch", "not_required", "open", "closed", "none"] as const;
export type SideState = (typeof SIDE_STATES)[number];

/** A posting run's status as a break's page reads it: `grouped` while it waits in an open posting group. */
export type PostingStatus = (typeof BREAK_ACTION_STATUSES)[number];
/**
 * What a row's status is read from: its group's kind (null for a lone item), the resolution of its items (for a group,
 * the first of them in the table's order), the lone item's status, a proposed counterpart, a pending request on one of
 * its items, and its latest posting run.
 */
export type ResultInput = {
  groupKind: GroupKind | null; resolution: Resolution | null; itemStatus: ItemStatus | null;
  proposed: boolean; pendingRequest: boolean; posting: PostingStatus | null;
};

const FAILED = new Set<PostingStatus>(["failed", "timeout", "not_sent"]);
const UNDER_WAY = new Set<PostingStatus>(["queued", "sending", "grouped"]);
const SKIPPED = new Set<PostingStatus>(["no_rule", "skipped"]);

/** The row's overall status: the first of the spec table that holds (keep in step with `statusSql` in the engine). */
export function resultStatus(x: ResultInput): ResultStatus {
  if (x.posting && FAILED.has(x.posting)) return "posting_failed";
  if (x.posting && UNDER_WAY.has(x.posting)) return "posting_in_progress";
  if (x.resolution === "POSTED" && x.posting && SKIPPED.has(x.posting)) return "posting_skipped";
  if (x.pendingRequest) return "waiting_approval";
  if (x.resolution === "POSTED") return "posted";
  if (x.resolution === "WRITTEN_OFF") return "written_off";
  if (x.resolution === "ADJUSTED") return "adjusted";
  if (x.resolution === "DUPLICATE" || x.resolution === "NO_ACTION" || x.itemStatus === "closed") return "closed";
  if (x.groupKind === "force" || x.resolution === "FORCE_MATCHED") return "force_matched";
  if (x.groupKind === "manual" || x.resolution === "MATCHED_MANUAL") return "matched_by_hand";
  if (x.resolution === "AUTO_MATCHED_LATE_DATA") return "matched_late";
  if (x.groupKind === "suggested" || x.itemStatus === "suggested" || (x.itemStatus === "break" && x.proposed)) return "suggested";
  if (x.groupKind === "auto" || x.itemStatus === "matched") return "matched";
  if (x.itemStatus === "break") return "unmatch";
  // a one-way recon's side-B item without a counterpart (DEC-055)
  if (x.itemStatus === "not_required") return "not_required";
  return "waiting_counterpart";
}

/** The widest business-date range one request reads (spec: at most 31 days). */
export const RESULT_RANGE_MAX_DAYS = 31;
/** Columns a recon's setup holds at most. */
export const RESULT_COLUMNS_MAX = 20;
/** A column heading's length. */
export const RESULT_LABEL_MAX = 60;
/** Members Explain lists per side. */
export const RESULT_MEMBERS_MAX = 100;
/** Recon info a column may show beside the source fields. */
export const RECON_INFO_FIELDS = ["businessDate", "pass", "reason", "assignee", "postingStatus", "bankReference", "resolutionNote", "resolvedAt"] as const;
export type ReconInfoField = (typeof RECON_INFO_FIELDS)[number];
export const RECON_INFO_LABEL: Record<ReconInfoField, string> = {
  businessDate: "Business date", pass: "Pass", reason: "Unmatch reason", assignee: "Assignee", postingStatus: "Posting status",
  bankReference: "Bank reference", resolutionNote: "Resolution note", resolvedAt: "Resolved at",
};
