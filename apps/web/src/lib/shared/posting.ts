import { formatDate, formatDateTime, formatTime } from "@starterkit/ui/lib/format";
import type { IndicatorStep } from "@starterkit/ui/ds";
import type { ActionRunDto } from "@starterkit/shared/contracts/breaks";
import type { StatusTone } from "@starterkit/ui/lib/status";
import { statusChip, statusChips } from "./categories";
import { groupKeyText as keyText, POSTING_STATUS_LABEL as L, type PostingStatus } from "@starterkit/shared/posting";

// An approval action's run (stage 4) as people read it: its status by meaning (categories.ts STATUS_TONE) with its own
// label (words from @starterkit/shared/posting, which the API's CSV uses too). Pure.

export { postingEvent, type PostingStatus } from "@starterkit/shared/posting";
import { LIVE_POLL_MS, LIVE_RUN_POLL_MS } from "./queries-recon";

/**
 * How often a screen showing these postings asks again: every 5 s while one is queued or sending (the worker answers in
 * seconds), every 15 s while one only waits in an open group (it goes when the group closes), else not at all.
 */
export function postingPollMs(statuses: readonly (PostingStatus | null | undefined)[]): number | false {
  if (statuses.some((s) => s === "queued" || s === "sending")) return LIVE_RUN_POLL_MS;
  return statuses.includes("grouped") ? LIVE_POLL_MS : false;
}
// a timeout's effect at the bank is unknown: red with the failures (owner 24 Nov); not sent sent nothing, so it needs a
// manual posting: red too (review 24 Nov)
export const postingChip = statusChips<PostingStatus>({
  posted: ["posted", L.posted], failed: ["failed", L.failed], not_sent: ["not_sent", L.not_sent], timeout: ["timeout", L.timeout], no_rule: ["no_rule", L.no_rule],
  skipped: ["skipped", L.skipped], queued: ["queued", L.queued], sending: ["sending", L.sending], grouped: ["waiting", L.grouped],
});
/** The status filter, the ones that need someone first (a timeout's effect at the bank is unknown: check it there). */
export const POSTING_FILTER: readonly { value: PostingStatus; label: string }[] = (["failed", "timeout", "not_sent", "posted", "no_rule", "skipped", "queued", "sending"] as const)
  .map((value) => ({ value, label: L[value] }));
/** A posting group's key as people read it ("Merchant id 0012345 · Business date 23 Nov 2026"): a date value as other dates are. */
export const groupKeyText = (keys: readonly { label: string; value: string }[]) =>
  keyText(keys.map((k) => (/^\d{4}-\d{2}-\d{2}$/.test(k.value) ? { ...k, value: formatDate(Date.parse(`${k.value}T00:00:00+07:00`)) } : k)));
/**
 * A posting group (stage 5): Open while it takes breaks (Degraded once `late`: still open past its due moment),
 * Closing while its run waits to send, then the run's result.
 */
export function groupChip(g: { status: "open" | "closed"; late?: boolean; run: { status: PostingStatus } | null }): { health: StatusTone; label: string } {
  if (g.status === "open") return g.late ? statusChip("late", "Open past its close") : statusChip("open", "Open");
  if (!g.run) return statusChip("nothing", "Nothing to send");
  return g.run.status === "queued" || g.run.status === "sending" ? statusChip("in_progress", "Closing") : postingChip(g.run.status);
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
/** A recon's posting groups still open past their due moment (Today). */
export const lateGroupsText = (n: number) => (n === 1 ? "1 posting group open past its close" : `${n} posting groups open past their close`);

type PipelineRun = Pick<ActionRunDto, "status" | "queuedAt" | "sendingAt" | "finishedAt" | "httpStatus" | "group">;
const NEVER_SENT: readonly PostingStatus[] = ["no_rule", "skipped", "not_sent"];
const seconds = (from: string, to: string) => { const s = (Date.parse(to) - Date.parse(from)) / 1000; return s < 1 ? "under 1 s" : `${s < 10 ? s.toFixed(1) : Math.round(s)} s`; };
/**
 * An action run's pipeline as steps: Queued → In group (grouped ones) → Sending → the bank's answer, each with its time;
 * the answer step names the result (Posted done; Failed, Timeout, Not sent red; No posting rule and Skipped greyed, as
 * nothing was sent), with the HTTP status and how long the call took.
 */
export function postingPipeline(a: PipelineRun): IndicatorStep[] {
  const s = a.status;
  const pending = s === "queued" || s === "grouped" || s === "sending";
  const never = NEVER_SENT.includes(s);
  const steps: IndicatorStep[] = [{ id: "queued", label: "Queued", status: "done", description: formatDateTime(Date.parse(a.queuedAt)) }];
  if (a.group) steps.push({ id: "group", label: "In group", status: s === "grouped" ? "current" : "done",
    description: s === "grouped" ? `Sends ${a.group.at === "cutoff" && a.group.closesAt ? `at ${formatTime(Date.parse(a.group.closesAt))}` : "at day close"}` : `Sent with ${a.group.items === 1 ? "1 item" : `${a.group.items} items`}` });
  steps.push({ id: "sending", label: "Sending", status: never ? "disabled" : s === "sending" ? "current" : pending ? "todo" : "done",
    description: never ? "Not sent" : a.sendingAt ? formatDateTime(Date.parse(a.sendingAt)) : "Not yet" });
  const result = s === "posted" ? "done" : s === "failed" || s === "timeout" || s === "not_sent" ? "error" : pending ? "todo" : "disabled";
  steps.push({ id: "answer", label: pending ? "Bank answer" : L[s], status: result,
    description: pending ? "Not yet" : [a.httpStatus != null && `HTTP ${a.httpStatus}`, a.finishedAt && formatDateTime(Date.parse(a.finishedAt)), a.sendingAt && a.finishedAt && seconds(a.sendingAt, a.finishedAt)].filter(Boolean).join(" · ") || "No answer" });
  return steps;
}
