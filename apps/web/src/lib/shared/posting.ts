import { POSTING_STATUS_LABEL as L, type PostingStatus } from "@starterkit/shared/posting";

// An approval action's run (stage 4) as people read it: its status as one of the five health states with its own
// label (words from @starterkit/shared/posting, which the API's CSV uses too). Pure.

export { postingEvent, type PostingStatus } from "@starterkit/shared/posting";
type Health = "healthy" | "degraded" | "down" | "stopped" | "unknown";
const HEALTH: Record<PostingStatus, Health> = { posted: "healthy", failed: "down", not_sent: "down", timeout: "degraded", no_rule: "stopped", skipped: "stopped", queued: "unknown", sending: "unknown" };
export const postingChip = (s: PostingStatus) => ({ health: HEALTH[s], label: L[s] });
/** The status filter, the ones that need someone first (a timeout's effect at the bank is unknown: check it there). */
export const POSTING_FILTER: readonly { value: PostingStatus; label: string }[] = (["failed", "timeout", "not_sent", "posted", "no_rule", "skipped", "queued", "sending"] as const)
  .map((value) => ({ value, label: L[value] }));
/** "2 failed, 1 timeout": a recon's runs of the last 24 hours that need someone (Today). */
export const attentionText = (c: { failed: number; timeout: number; notSent: number }) =>
  [c.failed && `${c.failed} failed`, c.timeout && `${c.timeout} timeout`, c.notSent && `${c.notSent} not sent`].filter(Boolean).join(", ");
