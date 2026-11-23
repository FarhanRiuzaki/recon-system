import { formatDate, formatTime } from "@starterkit/ui/lib/format";
import { groupKeyText, POSTING_STATUS_LABEL as L, type PostingStatus } from "@starterkit/shared/posting";

// An approval action's run (stage 4) as people read it: its status as one of the five health states with its own
// label (words from @starterkit/shared/posting, which the API's CSV uses too). Pure.

export { groupKeyText, postingEvent, type PostingStatus } from "@starterkit/shared/posting";
type Health = "healthy" | "degraded" | "down" | "stopped" | "unknown";
const HEALTH: Record<PostingStatus, Health> = { posted: "healthy", failed: "down", not_sent: "down", timeout: "degraded", no_rule: "stopped", skipped: "stopped", queued: "unknown", sending: "unknown", grouped: "unknown" };
export const postingChip = (s: PostingStatus) => ({ health: HEALTH[s], label: L[s] });
/** The status filter, the ones that need someone first (a timeout's effect at the bank is unknown: check it there). */
export const POSTING_FILTER: readonly { value: PostingStatus; label: string }[] = (["failed", "timeout", "not_sent", "posted", "no_rule", "skipped", "queued", "sending"] as const)
  .map((value) => ({ value, label: L[value] }));
/** A posting group (stage 5): Open while it takes breaks, Closing while its run waits to send, then the run's result. */
export function groupChip(g: { status: "open" | "closed"; run: { status: PostingStatus } | null }): { health: Health; label: string } {
  if (g.status === "open") return { health: "unknown", label: "Open" };
  if (!g.run) return { health: "stopped", label: "Nothing to send" };
  return g.run.status === "queued" || g.run.status === "sending" ? { health: "unknown", label: "Closing" } : postingChip(g.run.status);
}
/** When a group is sent: its cutoff time (Asia/Jakarta, the app's clock) or at the recon day's close. */
export const sendsAtText = (g: { at: "cutoff" | "day_close"; closesAt: string | null }) =>
  g.at === "cutoff" && g.closesAt ? formatTime(Date.parse(g.closesAt)) : "At day close";
/** A break waiting in its group: "In the 23 Nov 2026 group · Merchant id 0012345 · waiting until 16:00". */
export const waitingText = (g: { period: string; keys: readonly { label: string; value: string }[]; at: "cutoff" | "day_close"; closesAt: string | null }) =>
  `In the ${formatDate(Date.parse(`${g.period}T00:00:00+07:00`))} group · ${groupKeyText(g.keys)} · waiting until ${g.at === "cutoff" && g.closesAt ? formatTime(Date.parse(g.closesAt)) : "day close"}`;
/** "2 failed, 1 timeout": a recon's runs of the last 24 hours that need someone (Today). */
export const attentionText = (c: { failed: number; timeout: number; notSent: number }) =>
  [c.failed && `${c.failed} failed`, c.timeout && `${c.timeout} timeout`, c.notSent && `${c.notSent} not sent`].filter(Boolean).join(", ");
