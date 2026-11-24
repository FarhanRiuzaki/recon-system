// The connector call log as people read it (pure): an outcome's chip by meaning, an origin's words, who made a call.
import type { ConnectorCallRowDto } from "@starterkit/shared/contracts/integrations";
import { CALL_OUTCOME_LABEL as L, type CallOutcome } from "@starterkit/shared/integrations";
import { statusChips } from "@/lib/shared/categories";

/** OK green; Rejected, Timeout and Not sent red (a timeout's effect at the bank is unknown, a not sent call sent nothing). */
export const callChip = statusChips<CallOutcome>({ ok: ["success", L.ok], rejected: ["refused", L.rejected], timeout: ["timeout", L.timeout], not_sent: ["not_sent", L.not_sent] });
const OUTCOME_MEANS: Record<CallOutcome, string> = {
  ok: "The bank answered and the answer could be read.", rejected: "The bank refused the call (credentials, signature or the operation).",
  timeout: "Sent, but no readable answer in time: check with the bank what happened.", not_sent: "It never left: no address, credentials, certificate, network or token.",
};
/** The outcomes as the call log card's legend lists them. */
export const CALL_LEGEND = (["ok", "rejected", "timeout", "not_sent"] as const).map((o) => ({ ...callChip(o), description: OUTCOME_MEANS[o] }));
export const CALL_OUTCOME_OPTIONS: readonly { value: CallOutcome; label: string }[] = (["rejected", "timeout", "not_sent", "ok"] as const).map((value) => ({ value, label: L[value] }));

/** The words of the origins this app writes; another module's origin reads as its own words ("posting_group" → "Posting group"). */
const ORIGIN_LABEL: Record<string, string> = { "approvals.action": "Approval action", "integrations.try": "Try it", "integrations.token_check": "Check token" };
const words = (k: string) => { const t = k.replace(/_/g, " "); return t.charAt(0).toUpperCase() + t.slice(1); };
/** An origin filter value (`module.kind`) in words. */
export const originLabel = (key: string): string => ORIGIN_LABEL[key] ?? key.split(".").map(words).join(" · ");
export const originKey = (o: ConnectorCallRowDto["origin"]) => `${o.module}.${o.kind}`;

/** Who made the call: the person who clicked, or the system on behalf of the person whose decision fired it. */
export function callBy(r: Pick<ConnectorCallRowDto, "actor" | "onBehalfOf">): { name: string; note: string | null } {
  if (r.actor) return { name: r.actor.name ?? "A removed user", note: null };
  return { name: "System", note: r.onBehalfOf ? `for ${r.onBehalfOf.name ?? "a removed user"}` : null };
}

/** The call in words: its operation, or the token request. */
export const callName = (r: Pick<ConnectorCallRowDto, "operation">) => r.operation?.name ?? "Access token";
