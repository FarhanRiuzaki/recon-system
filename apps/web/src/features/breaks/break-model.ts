// The unmatch item page's words and choices, pure (no React): the comparison with its counterpart, how long it is
// checked again, where a request goes, and the ways to settle it in the page's order with one primary (audit B1–B6).
import { appDayStart, formatDate, formatMinor } from "@starterkit/ui/lib/format";
import type { RequestKind } from "@starterkit/shared/approvals";
import type { BreakDetailDto, BreakItemDto } from "@starterkit/shared/contracts/breaks";
import { CURRENCY_EXPONENT } from "@starterkit/shared/sources";
import { amountText } from "@/lib/shared/amount";

const DAY_MS = 86_400_000;
export const dateText = (d: string) => formatDate(appDayStart(d));
export const money = (i: Pick<BreakItemDto, "amountMinor" | "currency">) => `${amountText(i.amountMinor, i.currency)}${i.currency ? ` ${i.currency}` : ""}`;
const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
const signed = (n: bigint | number, text: string) => `${n > 0 ? "+" : "−"}${text}`;

/** The counterpart's amount minus this item's, in the item's currency; null without both amounts. */
export function amountDelta(a: BreakItemDto, b: BreakItemDto): string | null {
  if (a.amountMinor === null || b.amountMinor === null) return null;
  if (a.currency !== b.currency) return "Another currency";
  const d = BigInt(b.amountMinor) - BigInt(a.amountMinor);
  if (d === 0n) return "Same";
  const exp = a.currency ? CURRENCY_EXPONENT[a.currency] : undefined;
  const abs = d < 0n ? -d : d;
  return signed(d, `${exp === undefined ? String(abs) : formatMinor(abs, exp)}${a.currency ? ` ${a.currency}` : ""}`);
}

/** Days from business date `a` to `b`. */
export function dayDelta(a: string, b: string): string {
  const n = Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY_MS);
  return n === 0 ? "Same day" : signed(n, plural(Math.abs(n), "day"));
}

export type CompareLine = { label: string; a: string; b: string; delta?: string; differs: boolean };
/** This item and its counterpart, field by field; amount and date carry the difference. */
export function compareRows(a: BreakItemDto, b: BreakItemDto): CompareLine[] {
  const amount = amountDelta(a, b);
  return [
    { label: "Reference", a: a.ref ?? "No reference", b: b.ref ?? "No reference", differs: false },
    { label: "Amount", a: money(a), b: money(b), delta: amount ?? undefined, differs: amount !== null && amount !== "Same" },
    { label: "Business date", a: dateText(a.businessDate), b: dateText(b.businessDate), delta: dayDelta(a.businessDate, b.businessDate), differs: a.businessDate !== b.businessDate },
    { label: "Source", a: a.source ?? "—", b: b.source ?? "—", differs: false },
  ];
}

/** Several counterparts as one side: their total (one currency, else none), the latest date, the first reference. */
export function combined(items: readonly BreakItemDto[]): BreakItemDto | null {
  const [first] = items;
  if (!first || items.length === 1) return first ?? null;
  const one = items.every((i) => i.currency === first.currency && i.amountMinor !== null);
  return {
    ...first,
    ref: `${first.ref ?? "No reference"} and ${items.length - 1} more`,
    amountMinor: one ? String(items.reduce((t, i) => t + BigInt(i.amountMinor!), 0n)) : null,
    businessDate: items.reduce((d, i) => (i.businessDate > d ? i.businessDate : d), first.businessDate),
    source: new Set(items.map((i) => i.source)).size === 1 ? first.source : "Several sources",
  };
}

/** "checked again until 3 Nov (carry over 1 day)", or until it is settled while carry over is always. */
export function recheckText(r: BreakDetailDto["recon"]): string {
  if (r.carryOverDays === null || r.recheckUntil === null) return "checked again until it matches or is settled";
  return `checked again until ${dateText(r.recheckUntil)} (carry over ${plural(r.carryOverDays, "day")})`;
}

/** Where a request of `kind` goes by default: "Two levels · 2 levels · sent through Bank Mega"; null when unknown. */
export function routeText(r: BreakDetailDto["recon"], kind: RequestKind): string | null {
  const x = r.routes.find((t) => t.kind === kind);
  if (!x) return null;
  return [x.workflowName ?? "Default chain", plural(x.levels, "level"), x.connector ? `sent through ${x.connector}` : null].filter(Boolean).join(" · ");
}

export type SettleKey = "posting" | "match" | "force" | "writeOff" | "close";
export type Settle = { key: SettleKey; title: string; consequence: string; meta?: string; label: string; blocked: string | null; primary: boolean };

/**
 * The ways to settle an open unmatch item, in this order: Request posting (only when the recon posts), Match with a
 * counterpart, Force match, Write off, Close without a match. `blocked` = why nothing can be done yet (take it first);
 * `target` = what Match and Force match act on (the proposed pair, or the items ticked below). The primary is the next
 * step: posting when the recon posts, else the proposed pair; none while the item is blocked.
 */
export function settleActions(o: { recon: BreakDetailDto["recon"]; blocked: string | null; target: { proposed: boolean; count: number } }): Settle[] {
  const { recon: r, blocked, target } = o;
  const pick = target.count ? null : "Pick the counterpart below first.";
  const matchLabel = target.proposed ? "Match pair" : target.count > 1 ? `Match ${target.count} items` : "Match item";
  const all: Settle[] = [
    ...(r.posts ? [{ key: "posting" as const, title: "Request posting", consequence: "It goes for approval. On the final approval it closes as posted and is sent to the bank.", meta: routeText(r, "posting") ?? undefined, label: "Request posting", blocked, primary: false }] : []),
    { key: "match", title: "Match with counterpart", consequence: target.proposed ? "Matches it with the proposed pair. No approval needed." : "Matches it with the items you pick, when the totals are the same. No approval needed.", label: matchLabel, blocked: blocked ?? pick, primary: false },
    { key: "force", title: "Force match", consequence: "Matches it with the picked items although the totals differ. A checker approves first.", meta: routeText(r, "force_match") ?? undefined, label: "Request force match", blocked: blocked ?? pick, primary: false },
    { key: "writeOff", title: "Write off", consequence: "Closes it as written off once a checker approves.", meta: routeText(r, "write_off") ?? undefined, label: "Request write-off", blocked, primary: false },
    { key: "close", title: "Close without a match", consequence: "Closes it as a duplicate or as needing no action, with your note. No approval needed.", label: "Close item", blocked, primary: false },
  ];
  const next = blocked ? null : r.posts ? "posting" : target.proposed ? "match" : null;
  return all.map((a) => (a.key === next && !a.blocked ? { ...a, primary: true } : a));
}
