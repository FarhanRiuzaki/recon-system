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

/**
 * The counterpart's amount minus this item's, on the signed amounts a match totals (debit negated, then each side's
 * amount_sign), in the item's currency; null without both amounts.
 */
export function amountDelta(a: BreakItemDto, b: BreakItemDto): string | null {
  if (a.signedMinor === null || b.signedMinor === null) return null;
  if (a.currency !== b.currency) return "Another currency";
  const d = BigInt(b.signedMinor) - BigInt(a.signedMinor);
  if (d === 0n) return "Same";
  const exp = a.currency ? CURRENCY_EXPONENT[a.currency] : undefined;
  const abs = d < 0n ? -d : d;
  return signed(d, `${exp === undefined ? String(abs) : formatMinor(abs, exp)}${a.currency ? ` ${a.currency}` : ""}`);
}
/** Whether two items count the opposite way in a match (their signed amounts differ in sign): the unsigned amounts alone would mislead. */
export const oppositeWays = (a: BreakItemDto, b: BreakItemDto) =>
  a.signedMinor !== null && b.signedMinor !== null && a.signedMinor.startsWith("-") !== b.signedMinor.startsWith("-");
export const DIRECTION_LABEL = { debit: "Debit", credit: "Credit" } as const;

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
    ...(a.direction && b.direction && a.direction !== b.direction
      ? [{ label: "Direction", a: a.direction ? DIRECTION_LABEL[a.direction] : "–", b: b.direction ? DIRECTION_LABEL[b.direction] : "–", differs: true }] : []),
    { label: "Business date", a: dateText(a.businessDate), b: dateText(b.businessDate), delta: dayDelta(a.businessDate, b.businessDate), differs: a.businessDate !== b.businessDate },
    { label: "Source", a: a.source ?? "–", b: b.source ?? "–", differs: false },
  ];
}

/**
 * Several items of one side as one: their net signed total (one currency, else none) shown unsigned, the direction the
 * net counts as (that of an item whose signed amount has the net's sign: the side shares one amount_sign), the latest
 * date, the first reference. One item is itself, which reads the same way.
 */
export function combined(items: readonly BreakItemDto[]): BreakItemDto | null {
  const [first] = items;
  if (!first || items.length === 1) return first ?? null;
  const one = items.every((i) => i.currency === first.currency && i.signedMinor !== null);
  const net = one ? items.reduce((t, i) => t + BigInt(i.signedMinor!), 0n) : null;
  const like = net === null || net === 0n ? undefined : items.find((i) => i.direction && BigInt(i.signedMinor!) < 0n === net < 0n);
  return {
    ...first,
    ref: `${first.ref ?? "No reference"} and ${items.length - 1} more`,
    amountMinor: net === null ? null : String(net < 0n ? -net : net),
    signedMinor: net === null ? null : String(net),
    direction: like?.direction ?? (items.every((i) => i.direction === first.direction) ? first.direction : null),
    businessDate: items.reduce((d, i) => (i.businessDate > d ? i.businessDate : d), first.businessDate),
    source: new Set(items.map((i) => i.source)).size === 1 ? first.source : "Several sources",
  };
}
/**
 * What the summary compares, side against side as a match totals them: this item with the counterparts on its own
 * side (a group of several on both sides), against the other side's; `theirs` null when no item is on the other side.
 */
export function sidesOf(item: BreakItemDto, counterparts: readonly BreakItemDto[]) {
  const others = counterparts.filter((i) => i.id !== item.id);
  return { mine: combined([item, ...others.filter((i) => i.side === item.side)])!, theirs: combined(others.filter((i) => i.side !== item.side)) };
}

/**
 * Whether runs check the item again (the API's `recheck`), as of business date `today`; past tense once its last day
 * has gone. `pending`: a request waits for a decision, which is what holds it out of the runs.
 */
export function recheckText(r: BreakDetailDto["recon"]["recheck"], today: string, pending = false): string {
  if (r.kind === "always") return "Checked again on each run until it matches or is settled";
  if (r.kind === "no") return pending ? "Not checked again while a request waits" : "Not checked again – settle it here";
  return r.date < today ? `Checked again until ${dateText(r.date)}; no longer checked` : `Checked again on each run until ${dateText(r.date)}`;
}

type Route = BreakDetailDto["recon"]["routes"][number];
const routeOf = (r: BreakDetailDto["recon"], kind: RequestKind): Route | undefined => r.routes.find((t) => t.kind === kind);
/** Who approves a request of `kind` by default: "Treasury head, 2 levels", or the default chain's reviewer or space admin. */
export function approverText(r: BreakDetailDto["recon"], kind: RequestKind): string {
  const x = routeOf(r, kind);
  return x?.workflowName ? `${x.workflowName}, ${plural(x.levels, "level")}` : "a reviewer or space admin";
}
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
/**
 * Where a request of `kind` goes, as a card's meta: "Sent through Bank Mega" while its connector is on, and that its
 * rules pick the workflow on sending; null when there is nothing to say.
 */
export function routeText(r: BreakDetailDto["recon"], kind: RequestKind): string | null {
  const x = routeOf(r, kind);
  return [x?.connector && !x.connectorOff ? `Sent through ${x.connector}` : null, x?.note ?? null].filter(Boolean).join(" · ") || null;
}
/** A turned-off connector: asking still works (the server takes it), the posting waits as not sent. */
export function routeWarning(r: BreakDetailDto["recon"], kind: RequestKind): string | null {
  const x = routeOf(r, kind);
  return x?.connector && x.connectorOff ? `${x.connector} is turned off: the posting waits as not sent until it is on again` : null;
}
/** Why a request of `kind` can't be asked now: the server refuses it (its default workflow's version is gone). */
export const routeBlocked = (r: BreakDetailDto["recon"], kind: RequestKind): string | null => routeOf(r, kind)?.blocked ?? null;

export type Access = { worker: boolean; canWork: boolean; take: "first" | "offer" | null; blocked: string | null };
/**
 * Who may work an open item: a lead (reviewer, space admin, Superadmin) always, an operator once it is theirs. Take is
 * the first step only for whoever can't work it without taking it (an operator on an unassigned item); a lead is
 * offered it beside the ways to settle. `assignee` = the name of whoever has it, null when nobody does.
 */
export function workAccess(o: { lead: boolean; operator: boolean; mine: boolean; assignee: string | null; open: boolean; pending: boolean }): Access {
  const worker = o.lead || o.operator;
  const live = o.open && !o.pending;
  const canWork = live && (o.lead || o.mine);
  const take = live && worker && o.assignee === null ? (canWork ? "offer" : "first") : null;
  const blocked = canWork ? null : take === "first" ? "Take this item first." : `${o.assignee ?? "Someone"} has this item. A reviewer or space admin can reassign it from Unmatch.`;
  return { worker, canWork, take, blocked };
}
export const takeText = (take: "first" | "offer") => (take === "first"
  ? "Step 1 · Take this item. Whoever has it settles it; it shows as yours in Unmatch."
  : "Nobody has this item. You can settle it as it is, or take it so it shows as yours in Unmatch.");

/**
 * What the summary compares the item with: the items ticked in the picker once any is, else the request's items, the
 * ones it is matched with, the proposed pair; null when there is none.
 */
export function counterpartOf(o: { picked: readonly BreakItemDto[]; request: BreakDetailDto["request"]; matchedWith: readonly BreakItemDto[]; proposed: BreakDetailDto["proposed"]; open: boolean }) {
  if (o.picked.length) return { items: o.picked, label: "Picked", note: null };
  if (o.request?.status === "pending" && o.request.items.length) return { items: o.request.items, label: "In the request", note: null };
  if (o.matchedWith.length) return { items: o.matchedWith, label: "Matched with", note: null };
  if (o.open && o.proposed) {
    const p = o.proposed;
    return { items: [p.item], label: "Proposed pair", note: `Proposed by ${p.pass ? `pass ${p.pass} of ` : ""}a later run${p.available ? "" : "; that item was matched or resolved meanwhile"}.` };
  }
  return null;
}
/** The ticks once Find another counterpart opens or closes: closing it clears them, so nothing hidden is matched. */
export const findToggled = <T>(picked: ReadonlyMap<string, T>, open: boolean): ReadonlyMap<string, T> => (open ? picked : new Map());
/** The ticks once the proposed pair (its item id, null = none) changes: cleared, since Find another closes behind a new pair. */
export const picksAfter = <T>(picked: ReadonlyMap<string, T>, before: string | null, now: string | null): ReadonlyMap<string, T> => (before === now ? picked : new Map());

export type SettleKey = "posting" | "match" | "force" | "writeOff" | "close";
export type Settle = { key: SettleKey; title: string; consequence: string; meta?: string; warning?: string; label: string; blocked: string | null; primary: boolean };
export type Target = { kind: "proposed" } | { kind: "picked"; count: number } | { kind: "none" };

/**
 * The ways to settle an open unmatch item, in this order: Request posting (only when the recon posts), Match with a
 * counterpart, Force match, Write off, Close without a match. `access.blocked` = why nothing can be done yet; `target`
 * = what Match and Force match act on (the proposed pair, or the items ticked below), named on their buttons. A request
 * names who approves it and is blocked only while the server would refuse it; a turned-off connector is a warning. The primary is the next step: posting when the recon posts
 * (and it can be asked), else the proposed pair; none while the item is blocked.
 */
export function settleActions(o: { recon: BreakDetailDto["recon"]; access: Access; target: Target }): Settle[] {
  const { recon: r, target: t } = o;
  const blocked = o.access.blocked;
  const pick = t.kind === "none" ? "Pick the counterpart below first." : null;
  const picked = t.kind === "picked" ? t.count : 0;
  const items = (n: number) => (n === 1 ? "picked item" : `${n} picked items`);
  const what = t.kind === "proposed" ? "the proposed pair" : picked ? `the ${picked === 1 ? "item" : `${picked} items`} you picked` : "the items you pick";
  const req = (kind: RequestKind) => blocked ?? routeBlocked(r, kind);
  const all: Settle[] = [
    ...(r.posts ? [{ key: "posting" as const, title: "Request posting", consequence: `It goes for approval: ${approverText(r, "posting")} approves. On the final approval it closes as posted and is sent to the bank.`, meta: routeText(r, "posting") ?? undefined, warning: routeWarning(r, "posting") ?? undefined, label: "Request posting", blocked: req("posting"), primary: false }] : []),
    { key: "match", title: "Match with counterpart", consequence: `Matches it with ${what}${t.kind === "proposed" ? "" : ", when the totals are the same"}. No approval needed.`, label: t.kind === "proposed" ? "Match pair" : picked ? `Match with ${items(picked)}` : "Match item", blocked: blocked ?? pick, primary: false },
    { key: "force", title: "Force match", consequence: `Matches it with ${what} although the totals differ. ${cap(approverText(r, "force_match"))} approves first.`, meta: routeText(r, "force_match") ?? undefined, warning: routeWarning(r, "force_match") ?? undefined, label: t.kind === "proposed" ? "Force match pair" : picked ? `Force match with ${items(picked)}` : "Force match", blocked: req("force_match") ?? pick, primary: false },
    { key: "writeOff", title: "Write off", consequence: `Closes it as written off once ${approverText(r, "write_off")} approves.`, meta: routeText(r, "write_off") ?? undefined, warning: routeWarning(r, "write_off") ?? undefined, label: "Request write-off", blocked: req("write_off"), primary: false },
    { key: "close", title: "Close without a match", consequence: "Closes it as a duplicate or as needing no action, with your note. No approval needed.", label: "Close item", blocked, primary: false },
  ];
  const posting = all.find((a) => a.key === "posting");
  const next = blocked ? null : posting && !posting.blocked ? "posting" : t.kind === "proposed" ? "match" : null;
  return all.map((a) => (a.key === next && !a.blocked ? { ...a, primary: true } : a));
}
