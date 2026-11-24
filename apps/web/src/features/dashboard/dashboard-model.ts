// The recon dashboard's pure parts: who sees the admin section, the IDR headline of an amount list, rates and their
// change, and the links each number opens with its filters (docs/superpowers/plans/2026-11-24-recon-dashboard.md).
import { REQUEST_KINDS } from "@starterkit/shared/approvals";
import type { ReconDashboardDto } from "@starterkit/shared/contracts/dashboard";
import { POSTING_FAILED } from "@starterkit/shared/dashboard";
import type { PermissionName } from "@starterkit/shared/permissions";
import { formatDecimal, formatSignedNumber } from "@starterkit/ui/lib/format";
import type { Delta } from "@starterkit/ui/ds";
import { amountText } from "@/lib/shared/amount";

type Amounts = ReconDashboardDto["open"]["amounts"];
const MINUS = "−";

/** The user, session and sign-in numbers sit at the bottom for holders of `user.view` or `audit.view` only. */
export const adminSection = (can: (p: PermissionName) => boolean): boolean => can("user.view") || can("audit.view");

/** The headline currency: IDR. Its amount (0 when none is open in IDR) and the other currencies, each on its own. */
export function idrHeadline(amounts: Amounts): { value: string; others: string[] } {
  const idr = amounts.find((a) => a.currency === "IDR");
  return { value: amountText(idr?.amountMinor ?? "0", "IDR"), others: amounts.filter((a) => a.currency !== "IDR").map((a) => `${amountText(a.amountMinor, a.currency)} ${a.currency}`) };
}

/** A share 0–1, null when there is nothing to divide. */
export const rate = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);

/** A count against the period before; `good` = the direction that is good news. */
export function countDelta(now: number, before: number, good: "up" | "down"): Delta {
  return { text: `${formatSignedNumber(now - before)} vs previous period`, direction: now > before ? "up" : now < before ? "down" : "flat", good };
}
/** A rate against the period before, in percentage points; none when either side has nothing. */
export function rateDelta(now: number | null, before: number | null, good: "up" | "down"): Delta | undefined {
  if (now === null || before === null) return undefined;
  const pts = Math.round((now - before) * 1000) / 10;
  return { text: `${pts === 0 ? "0" : `${pts > 0 ? "+" : MINUS}${formatDecimal(Math.abs(pts), 1)}`} pts vs previous period`, direction: pts > 0 ? "up" : pts < 0 ? "down" : "flat", good };
}

/** A query string; a list value repeats its key (a check filter's ticked values, as the lists read them). */
const q = (params: Record<string, string | readonly string[] | null | undefined>) => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) for (const x of typeof v === "string" ? [v] : v ?? []) if (x) sp.append(k, x);
  return sp.size ? `?${sp}` : "";
};
const space = (id: string) => `/spaces/${encodeURIComponent(id)}`;

/** The Unmatch list of the space, the recon's, with `age` buckets or one `reason`. */
export const unmatchHref = (spaceId: string, f: { recon?: string | null; age?: readonly string[]; reason?: string } = {}) =>
  `${space(spaceId)}/breaks${q({ recon: f.recon, age: f.age, reason: f.reason })}`;
/** One recon's Operation result over the period, with `statuses` ticked. */
export const resultsHref = (spaceId: string, recon: string, period: { from: string; to: string }, statuses: readonly string[] = []) =>
  `${space(spaceId)}/results${q({ recon, dateFrom: period.from, dateTo: period.to, result: statuses })}`;
/** The Posting list's failed posting runs of the period (and the recon). */
export const postingFailedHref = (spaceId: string, period: { from: string; to: string }, recon?: string | null) =>
  `${space(spaceId)}/posting${q({ kind: "posting", status: POSTING_FAILED, recon, dateFrom: period.from, dateTo: period.to })}`;
/** The approvals inbox with every break request of the space, not only the viewer's. */
export const approvalsHref = (spaceId: string) => `${space(spaceId)}/approvals${q({ mine: "0", kind: REQUEST_KINDS })}`;

/** The one space a number's link opens: the space picked, or the viewer's only one; null across several. */
export const linkSpace = (d: Pick<ReconDashboardDto, "spaces">, picked: string | null): string | null =>
  picked ?? (d.spaces.length === 1 ? d.spaces[0]!.id : null);
