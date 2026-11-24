// The recon dashboard's vocabulary (docs/superpowers/plans/2026-11-24-recon-dashboard.md "Number definitions"),
// zod-free: the API counts with it and the screen links with it, so a number and the list it opens use the same values.
import type { AgeBucket } from "./recon";
import type { ResultStatus } from "./results";

/** Operation result statuses of a resolved unmatch (the Resolved tile and its link). */
export const RESOLVED_STATUSES = ["matched_late", "matched_by_hand", "force_matched", "posted", "written_off", "adjusted", "closed"] as const satisfies readonly ResultStatus[];

/** How items were closed in the period: each part's label and the Operation result statuses it counts. */
export const CLOSED_PARTS = [
  { key: "auto", label: "Auto match", statuses: ["matched"] },
  { key: "late", label: "Late data", statuses: ["matched_late"] },
  { key: "manual", label: "By hand", statuses: ["matched_by_hand"] },
  { key: "force", label: "Force match", statuses: ["force_matched"] },
  { key: "posted", label: "Posted", statuses: ["posted"] },
  { key: "written_off", label: "Written off", statuses: ["written_off"] },
  { key: "closed", label: "Closed", statuses: ["closed", "adjusted"] },
] as const satisfies readonly { key: string; label: string; statuses: readonly ResultStatus[] }[];
export type ClosedPart = (typeof CLOSED_PARTS)[number]["key"];

/** The dashboard's age groups over the Unmatch list's age buckets (> 7 d is flagged). */
export const AGE_GROUPS = [
  { key: "d0_1", label: "0–1 d", buckets: ["d0", "d1"] },
  { key: "d2_3", label: "2–3 d", buckets: ["d2_3"] },
  { key: "d4_7", label: "4–7 d", buckets: ["d4_7"] },
  { key: "gt7", label: "> 7 d", buckets: ["d8_30", "gt30"] },
] as const satisfies readonly { key: string; label: string; buckets: readonly AgeBucket[] }[];
export type AgeGroup = (typeof AGE_GROUPS)[number]["key"];

/** Posting run statuses that count as failed (the Posting list's attention statuses). */
export const POSTING_FAILED = ["failed", "timeout", "not_sent"] as const;
/** Posting runs that finished: posted or failed (no_rule and skipped sent nothing, queued and sending go on). */
export const POSTING_FINISHED = ["posted", ...POSTING_FAILED] as const;

/** The middle of `xs` (the mean of the two middle values for an even count); null for none. */
export function median(xs: readonly number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}
