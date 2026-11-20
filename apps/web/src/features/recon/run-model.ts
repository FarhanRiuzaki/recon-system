// What a run says on the recon screens (BUILDER-SPEC "Simulation bar", "Connectors", "Pass outcome"; Task 5 results per
// pass): the state of a draft's simulation, its totals, a pass's outcome, the funnel between passes, an item's
// difference. Pure: the builder, the simulation bar and the run page read the same numbers from here.
import { APP_TIME_ZONE_LABEL, appDate, appDayStart, formatDate, formatDecimal, formatMinor, formatNumber, formatTime, shiftDate } from "@starterkit/ui/lib/format";
import type { DateRange } from "@starterkit/ui/lib/date-range";
import type { PassSpec, ReconRunDto, ReconSpec } from "@starterkit/shared/contracts/recon";
import { RUN_RANGE_MAX_DAYS } from "@starterkit/shared/recon";
import { CURRENCY_EXPONENT } from "@starterkit/shared/sources";

type Run = Pick<ReconRunDto, "status" | "from" | "to" | "counters" | "error" | "finishedAt" | "specHash">;
type Version = { version: number; specHash: string; simulatedHash: string | null };

/** A run the worker hasn't finished: the screen polls it. */
export const isLive = (r: { status: string } | null | undefined) => r?.status === "queued" || r?.status === "running";

const dayText = (d: string) => formatDate(appDayStart(d));
/** "20 Nov 2026", "2–5 Nov 2026", "30 Oct – 2 Nov 2026", "30 Dec 2026 – 2 Jan 2027": business dates from–to. */
export function rangeText(from: string, to: string): string {
  const [fy, fm] = [from.slice(0, 4), from.slice(5, 7)], [ty, tm] = [to.slice(0, 4), to.slice(5, 7)];
  if (from === to) return `${dayText(from)} ${fy}`;
  if (fy === ty && fm === tm) return `${Number(from.slice(8))}–${dayText(to)} ${ty}`;
  if (fy === ty) return `${dayText(from)} – ${dayText(to)} ${ty}`;
  return `${dayText(from)} ${fy} – ${dayText(to)} ${ty}`;
}

/** The replay range before any simulation: the day before today (the last day a daily run covers). */
export const defaultReplay = (now = Date.now()): DateRange => { const d = shiftDate(appDate(now), -1); return { from: d, to: d }; };
/** The last business date a replay starting on `from` may end on (RUN_RANGE_MAX_DAYS dates, none after today). */
export function replayEnd(from: string, today: string): string {
  const last = shiftDate(from, RUN_RANGE_MAX_DAYS - 1);
  return last < today ? last : today;
}

/** Why a pass breaks the items it can't pair without guessing: the engine's own rule (engine sql/breaks.ts). */
export const breakLabel = (p: PassSpec) =>
  (p.blocking.length || p.predicates.some((q) => q.op === "eq" || q.op === "eq_normalized") ? "Duplicate" : "Ambiguous");

type Counters = ReconRunDto["counters"];
type PassCount = Counters["passes"][string];
/**
 * Side A items a pass matched: its per-side count, or for a run before those counts one per group where a group holds
 * one side A item (1:1, 1:N); null for an older N:1 pass.
 */
const matchedA = (p: PassSpec, x: PassCount) => x.matchedItems?.a ?? (p.cardinality === "N:1" && x.matched ? null : x.matched);

/**
 * A run's totals over its passes: groups matched and suggested, items broken (by label) with their references, items
 * still open per side, items taken in (current records). `rate` = side A items matched / side A items in, suggested
 * counted as open; null when the counters can't say it.
 */
export function runTotals(c: Counters, spec: ReconSpec) {
  let matched = 0, suggested = 0, duplicate = 0, ambiguous = 0, refs: number | null = 0, a: number | null = 0;
  for (const p of spec.passes) {
    const x = c.passes[String(p.no)];
    if (!x) continue;
    matched += x.matched;
    suggested += x.suggested;
    if (breakLabel(p) === "Duplicate") { duplicate += x.broken; refs = refs === null || x.brokenRefs === undefined ? (x.broken ? null : refs) : refs + x.brokenRefs; }
    else ambiguous += x.broken;
    const m = matchedA(p, x);
    a = a === null || m === null ? null : a + m;
  }
  const inA = c.intake.a - c.replaced.a, inB = c.intake.b - c.replaced.b;
  const rate = a !== null && inA > 0 ? a / inA : null;
  return { matched, suggested, duplicate, duplicateRefs: refs, ambiguous, waiting: c.open, items: inA + inB, in: { a: inA, b: inB }, rate };
}

/** "93.7%" (one decimal, as the design writes it), or "—". */
export const rateText = (rate: number | null) => (rate === null ? "—" : `${formatDecimal(rate * 100, 1)}%`);

/** "937 matched · 24 suggested (open) · 30 duplicate · 24 · 24 waiting · match rate 93.7%" (BUILDER-SPEC count line). */
export function countLine(t: ReturnType<typeof runTotals>): string {
  return [`${formatNumber(t.matched)} matched`, `${formatNumber(t.suggested)} suggested (open)`, `${formatNumber(t.duplicate)} duplicate`,
    ...(t.ambiguous ? [`${formatNumber(t.ambiguous)} ambiguous`] : []), `${formatNumber(t.waiting.a)} · ${formatNumber(t.waiting.b)} waiting`, `match rate ${rateText(t.rate)}`].join(" · ");
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
export type SimView = { chip: { health: "healthy" | "degraded" | "unknown"; label: string }; line: string; counts: Run | null; dim: boolean };
/**
 * The simulation bar of a draft (BUILDER-SPEC chips and lines): `run` = its latest simulation, `shown` = its latest one
 * that succeeded (its numbers stay, dimmed, while the next one runs or once the draft changed), `dirty` = edits not
 * saved yet.
 */
export function simView(v: Version, run: Run | null, shown: Run | null, dirty: boolean): SimView {
  const draft = `Draft v${v.version}`;
  if (run && isLive(run)) return { chip: { health: "unknown", label: "Running" }, line: `${draft} · ${rangeText(run.from, run.to)}`, counts: shown, dim: true };
  if (run?.status === "failed") {
    return { chip: { health: "unknown", label: "Not simulated" }, line: `The simulation stopped: ${lowerFirst(run.error ?? "the run stopped before it finished. Run it again.")}`, counts: null, dim: false };
  }
  if (v.simulatedHash === null || !shown) return { chip: { health: "unknown", label: "Not simulated" }, line: `${draft} · not simulated yet`, counts: null, dim: false };
  if (dirty || v.simulatedHash !== v.specHash || shown.specHash !== v.specHash) {
    return { chip: { health: "degraded", label: "Out of date" }, line: "The draft changed after the last simulation", counts: shown, dim: true };
  }
  const items = shown.counters.intake.a - shown.counters.replaced.a + shown.counters.intake.b - shown.counters.replaced.b;
  const at = shown.finishedAt ? ` · ${formatTime(Date.parse(shown.finishedAt))} ${APP_TIME_ZONE_LABEL}` : "";
  return { chip: { health: "healthy", label: "Simulated" }, line: `${draft} · ${rangeText(shown.from, shown.to)} · ${formatNumber(items)} items${at}`, counts: shown, dim: false };
}

/** Why Submit for approval waits on a simulation that is running (BUILDER-SPEC), before submitReason's own reasons. */
export const RUNNING_REASON = "Wait for the simulation to finish.";

/** The items a pass took from each side (matched, suggested, broken), or null for a run before per-side counts. */
function takenBy(p: PassSpec, x: PassCount): { a: number; b: number } | null {
  if (x.matchedItems && x.suggestedItems && x.brokenItems) {
    return { a: x.matchedItems.a + x.suggestedItems.a + x.brokenItems.a, b: x.matchedItems.b + x.suggestedItems.b + x.brokenItems.b };
  }
  return p.cardinality === "1:1" && !x.broken ? { a: x.matched + x.suggested, b: x.matched + x.suggested } : null;
}

/**
 * The connector under the sides (`after` = 0) and under pass `after` (BUILDER-SPEC "Connectors"): what comes in; what
 * is left per side once the passes before took their items, with the sum per side after a pass that broke items
 * ("1,000 = 937 matched + 15 duplicate + 48 left, per side" when both sides say the same); the last says what stays
 * open. Null where the counters can't split it per side (a run before those counts).
 */
export function connectorText(c: Counters, spec: ReconSpec, after: number): string | null {
  const [la, lb] = [spec.sides[0].label, spec.sides[1].label];
  const per = (a: number, b: number) => `${formatNumber(a)} ${la} · ${formatNumber(b)} ${lb}`;
  if (after >= spec.passes.length && spec.passes.length) return `Unmatched: ${per(c.open.a, c.open.b)}`;
  const t = runTotals(c, spec);
  if (after === 0) return `In: ${per(t.in.a, t.in.b)}`;
  const left = { ...t.in }, before = { ...t.in };
  for (const p of spec.passes.slice(0, after)) {
    const x = c.passes[String(p.no)];
    const took = x ? takenBy(p, x) : { a: 0, b: 0 };
    if (!took) return null;
    Object.assign(before, left);
    left.a -= took.a;
    left.b -= took.b;
  }
  const text = `Left: ${per(left.a, left.b)}`;
  // after a pass that broke items, the sum per side, when both sides read the same
  const p = spec.passes[after - 1]!, x = c.passes[String(p.no)];
  const m = x?.matchedItems, s = x?.suggestedItems, b = x?.brokenItems;
  if (!m || !s || !b || !b.a || m.a !== m.b || s.a !== s.b || b.a !== b.b || before.a !== before.b) return text;
  const parts = [m.a ? `${formatNumber(m.a)} matched` : "", s.a ? `${formatNumber(s.a)} suggested` : "", `${formatNumber(b.a)} ${breakLabel(p).toLowerCase()}`, `${formatNumber(left.a)} left`];
  return `${text}  (${formatNumber(before.a)} = ${parts.filter(Boolean).join(" + ")}, per side)`;
}

/** A pass's outcome beside its card: what it did, how much, and what that means (BUILDER-SPEC "Pass outcome"). */
export function passOutcome(c: ReconRunDto["counters"], spec: ReconSpec, p: PassSpec): { tag: string; tone: "neutral" | "warn"; count: string; note: string }[] {
  const x = c.passes[String(p.no)];
  if (!x) return [];
  const unit = p.cardinality === "1:1" ? "pairs" : "groups";
  const out: ReturnType<typeof passOutcome> = [];
  if (p.accept === "auto" || x.matched) {
    const inA = c.intake.a - c.replaced.a, a = matchedA(p, x);
    const share = a !== null && inA > 0 ? `${formatDecimal((a / inA) * 100, 1)}% of ${spec.sides[0].label} items in` : "";
    out.push({ tag: "Matched", tone: "neutral", count: `${formatNumber(x.matched)} ${unit}`, note: share });
  }
  if (p.accept === "suggest" || x.suggested) out.push({ tag: "Suggested", tone: "neutral", count: `${formatNumber(x.suggested)} ${unit}`, note: "open until accepted" });
  if (x.broken) {
    const refs = x.brokenRefs !== undefined && breakLabel(p) === "Duplicate" ? `${formatNumber(x.brokenRefs)} refs · ` : "";
    out.push({ tag: breakLabel(p), tone: "warn", count: `${refs}${formatNumber(x.broken)} items`, note: "need review" });
  }
  return out;
}

/** Evidence of a group as the engine writes it (engine sql/pass.ts pairEvidence). */
export type Evidence = { pass?: number; name?: string; chosen?: string; predicates?: { op: string; field: unknown; passed: boolean; delta?: number | string | null }[] };
export const evidenceOf = (e: unknown): Evidence => (e && typeof e === "object" ? (e as Evidence) : {});

/** "+500.00" from a delta in minor units of `ccy` (side B − side A); null without a currency the product knows. */
function amountDelta(minor: number | string, ccy: string | null): string | null {
  const exp = ccy ? CURRENCY_EXPONENT[ccy] : undefined;
  if (exp === undefined || !/^-?\d+(\.0+)?$/.test(String(minor))) return null;
  const v = BigInt(String(minor).split(".")[0]!);
  return `${v > 0n ? "+" : ""}${formatMinor(v, exp)}`;
}
/** "+1 day", "-2 days" from a delta in days. */
function dayDelta(d: number | string): string {
  const n = Number(d);
  return `${n > 0 ? "+" : ""}${formatNumber(n)} ${Math.abs(n) === 1 ? "day" : "days"}`;
}

/**
 * What differs between the two sides of a group, from its evidence (side B − side A): "Amount +500.00", "Date +1 day";
 * "" when the pair is equal on what the pass compares. `ccy` = the currency of the amounts.
 */
export function differenceText(evidence: unknown, ccy: string | null): string {
  const parts: string[] = [];
  for (const q of evidenceOf(evidence).predicates ?? []) {
    if (q.delta === null || q.delta === undefined || Number(q.delta) === 0) continue;
    if (q.op === "amount_abs_tol" || q.op === "amount_pct_tol" || q.op === "eq_sum") { const t = amountDelta(q.delta, ccy); if (t) parts.push(`Amount ${t}`); }
    else if (q.op === "date_window") parts.push(`Date ${dayDelta(q.delta)}`);
    else if (q.op === "bday_window") parts.push(`Business date ${dayDelta(q.delta)}`);
  }
  return parts.join(" · ");
}

/** An item's amount: "25,517.79" in its currency's minor unit, or the raw minor value when the currency is unknown. */
export function amountText(minor: string | null, ccy: string | null): string {
  if (minor === null) return "—";
  const exp = ccy ? CURRENCY_EXPONENT[ccy] : undefined;
  return exp === undefined ? minor : formatMinor(BigInt(minor), exp);
}
