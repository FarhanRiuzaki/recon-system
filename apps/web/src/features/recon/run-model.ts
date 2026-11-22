// What a run says on the recon screens (BUILDER-SPEC "Simulation bar", "Connectors", "Pass outcome"; Task 5 results per
// pass): the state of a draft's simulation, its totals, a pass's outcome, the funnel between passes, an item's
// difference. Pure: the builder, the simulation bar and the run page read the same numbers from here.
import { APP_TIME_ZONE_LABEL, appDate, appDayStart, formatDate, formatDecimal, formatMinor, formatNumber, formatTime, shiftDate } from "@starterkit/ui/lib/format";
import type { DateRange } from "@starterkit/ui/lib/date-range";
import type { PassSpec, ReconRunDto, ReconRunItemDto, ReconSpec, RunDay, RunProjection } from "@starterkit/shared/contracts/recon";
import { BREAK_REASONS, RUN_RANGE_MAX_DAYS } from "@starterkit/shared/recon";
import { CURRENCY_EXPONENT } from "@starterkit/shared/sources";

type Run = Pick<ReconRunDto, "status" | "mode" | "from" | "to" | "counters" | "error" | "finishedAt" | "specHash">;
type Version = { version: number; matchingHash: string; simulatedHash: string | null };

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
/**
 * How many of business dates `from`..`to` are past their close moment at `now` (as the API's closeMoment: a daily
 * recon's date closes at its run time on the date `business_date_offset` days later, else at `close_at`, WIB): a run
 * over them makes their open items breaks.
 */
export function pastClose(spec: Pick<ReconSpec, "close_at" | "schedule">, r: DateRange, now = Date.now()): number {
  let n = 0;
  for (let d = r.from; d <= r.to; d = shiftDate(d, 1)) {
    const [day, at] = spec.schedule.kind === "daily" ? [shiftDate(d, spec.schedule.business_date_offset), spec.schedule.at] : [d, spec.close_at];
    if (Date.parse(`${day}T${at}:00+07:00`) <= now) n++;
  }
  return n;
}

export const defaultReplay = (now = Date.now()): DateRange => { const d = shiftDate(appDate(now), -1); return { from: d, to: d }; };
/** The business dates a source has records on, among the 7 its list row counts (`recent`, oldest first, up to its health's date). */
export function recordDates(row: { recent: readonly number[]; health: { businessDate: string } | null } | undefined): string[] {
  if (!row?.health || !row.recent.length) return [];
  const last = row.health.businessDate, n = row.recent.length;
  return row.recent.flatMap((c, i) => (c > 0 ? [shiftDate(last, i - (n - 1))] : []));
}
/**
 * The replay a simulation starts with (owner, 22 Nov: never a date without data): the latest date before `today` on
 * which both sides have records (a closed day, spec §10), else the latest such date at all (today, still open), else
 * the latest date either side has, else yesterday (defaultReplay). `a`/`b` = recordDates of each side; null while loading.
 */
export function suggestedReplay(a: readonly string[] | null, b: readonly string[] | null, today: string): DateRange | null {
  if (!a || !b) return null;
  const both = a.filter((d) => b.includes(d) && d <= today).sort();
  const before = both.filter((d) => d < today);
  const d = before.at(-1) ?? both.at(-1) ?? [...a, ...b].filter((x) => x <= today).sort().at(-1);
  return d ? { from: d, to: d } : null;
}
/** Why a replay finds nothing: the dates in it with no records on a side, said with where records are; null when both have some. */
export function replayGap(r: DateRange, sides: readonly { label: string; dates: readonly string[] }[]): string | null {
  const empty = sides.filter((s) => !s.dates.some((d) => d >= r.from && d <= r.to));
  if (!empty.length) return null;
  const known = sides.flatMap((s) => s.dates).sort();
  const span = r.from === r.to ? formatDate(Date.parse(`${r.from}T00:00:00+07:00`)) : "these dates";
  const where = known.length ? ` Records are on ${[...new Set(known)].slice(-3).map((d) => formatDate(Date.parse(`${d}T00:00:00+07:00`))).join(", ")}.` : "";
  return `${empty.map((s) => s.label).join(" and ")} ${empty.length > 1 ? "have" : "has"} no records on ${span}.${where}`;
}
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
  return { matched, suggested, duplicate, duplicateRefs: refs, ambiguous, waiting: c.open, breaks: null as PerSide | null, items: inA + inB, in: { a: inA, b: inB }, rate };
}
type PerSide = { a: number; b: number };
export type Totals = ReturnType<typeof runTotals>;

/**
 * A run's totals as they stand now (the run page, a recon's last run): `live` and the run's `days` once the API has
 * them (suggestions confirmed or broken since, breaks of time per side, waiting items), else what the run itself did
 * (`counters`). Items taken in, references and the pass split stay the run's own.
 */
/** `live.items` (current records per side over the run's dates): added by the runs agent; optional until it lands. */
export function standingTotals(run: Pick<ReconRunDto, "counters" | "days" | "live" | "from" | "to">, spec: ReconSpec): Totals {
  const own = runTotals(run.counters, spec);
  if (!run.live || !run.days) return own;
  let duplicate = 0, ambiguous = 0;
  for (const d of runDays(run)) { const t = dayTotals(d, spec); duplicate += t.duplicate; ambiguous += t.ambiguous; }
  // the match rate of the run's business dates as they stand (Captain): side A items matched / side A records now
  // (live.items), so a run that took in nothing new still has one. ponytail: one side A item per matched group; an N:1
  // pass that matched, or a run without live.items, keeps the run's own rate
  const n1 = spec.passes.some((p) => p.cardinality === "N:1" && run.counters.passes[String(p.no)]?.matched);
  const items = run.live.items;
  const rate = n1 || !items ? own.rate : items.a > 0 ? run.live.matched / items.a : null;
  return { ...own, matched: run.live.matched, suggested: run.live.suggested, duplicate, ambiguous, waiting: run.live.open, breaks: run.live.breaks, rate };
}

/** A run's own business dates among its days (from..to): the carry-over date before them is a tile, never in the totals, as `live`. */
export const runDays = <D extends { date: string }>(run: { days: readonly D[] | null; from: string; to: string }): D[] =>
  (run.days ?? []).filter((d) => d.date >= run.from && d.date <= run.to);

/**
 * The Breaks tab's count: every break item over the run's own dates per side, the sum of `live.breakReasons` (a pass's
 * Duplicate included), so it equals the list's total; before the API sent reasons, breaks of time plus the items passes
 * broke. Null for a simulation (nothing closes, no Breaks tab) or a run whose live totals the API hasn't read.
 */
export function breakCounts(run: Pick<ReconRunDto, "mode" | "counters" | "live">): PerSide | null {
  if (run.mode === "simulation" || !run.live) return null;
  if (run.live.breakReasons) return sumSides(Object.values(run.live.breakReasons));
  const out = { ...run.live.breaks };
  for (const x of Object.values(run.counters.passes)) { out.a += x.brokenItems?.a ?? 0; out.b += x.brokenItems?.b ?? 0; }
  return out;
}
const sumSides = (xs: readonly PerSide[]) => xs.reduce((t, x) => ({ a: t.a + x.a, b: t.b + x.b }), { a: 0, b: 0 });

/** A real run's breaks per side (every reason, a pass's Duplicate included) and the duplicates among them. */
export type Breaks = { breaks: PerSide; duplicate: PerSide };
/** Breaks and duplicates from a by-reason count (a run's own dates, or one day); null without one. */
export function breaksOf(byReason: Readonly<Record<string, PerSide>> | null | undefined): Breaks | null {
  if (!byReason) return null;
  return { breaks: sumSides(Object.values(byReason)), duplicate: byReason.Duplicate ?? { a: 0, b: 0 } };
}
/**
 * Breaks as every screen of a real run says them (Captain: one definition, Duplicate is a break reason): "63 breaks
 * per side (15 duplicate per side)", or the sides named when they differ ("63 src1 r2 · 62 src2 r2b breaks (15 src1 r2
 * · 14 src2 r2b duplicate)"); no brackets without duplicates. `noun` false drops "breaks" (the Breaks tab's title).
 */
export function breaksText(x: Breaks, labels: readonly [string, string], noun = true): string {
  const main = noun ? sidesText(x.breaks, labels, "unmatch") : x.breaks.a === x.breaks.b ? `${formatNumber(x.breaks.a)} per side` : `${formatNumber(x.breaks.a)} ${labels[0]} · ${formatNumber(x.breaks.b)} ${labels[1]}`;
  return x.duplicate.a || x.duplicate.b ? `${main} (${sidesText(x.duplicate, labels, "duplicate")})` : main;
}

/**
 * A run's count line: a real run with its live totals reads what stands now with breaks by the one definition ("937
 * matched · 63 breaks per side (15 duplicate per side) · match rate 93.7%"; suggested and waiting when there are any);
 * a simulation, or a run before live totals, keeps the run's own counts (countLine: duplicates by their pass).
 */
export function runLine(run: Pick<ReconRunDto, "mode" | "counters" | "days" | "live" | "from" | "to">, spec: ReconSpec, labels: readonly [string, string]): string {
  const t = standingTotals(run, spec);
  const b = run.mode === "simulation" ? null : breaksOf(run.live?.breakReasons);
  if (!b) return countLine(t, labels);
  return [`${formatNumber(t.matched)} matched`, ...(t.suggested ? [`${formatNumber(t.suggested)} suggested (open)`] : []),
    ...(t.waiting.a || t.waiting.b ? [sidesText(t.waiting, labels, "waiting")] : []), ...(b.breaks.a || b.breaks.b ? [breaksText(b, labels)] : []),
    `match rate ${rateText(t.rate)}`].join(" · ");
}

/**
 * The Breaks tab's reason filter (designer, Figma 205:6752): "All 126", then each reason that has items, in day close's
 * order, with its items on both sides ("Duplicate 30"). `value` "" = all.
 */
export function reasonOptions(byReason: Readonly<Record<string, PerSide>>): { value: string; label: string; count: number }[] {
  const count = (x: PerSide) => x.a + x.b;
  const present = BREAK_REASONS.filter((r) => byReason[r] && count(byReason[r]!) > 0);
  return [{ value: "", label: "All", count: count(sumSides(Object.values(byReason))) }, ...present.map((r) => ({ value: r, label: r, count: count(byReason[r]!) }))];
}

type Rec = { amountMinor: string | null; currency: string | null; businessDate: string };
/** A break's pair as the Breaks tab and Explain show it. */
export type BreakPair = { side: "a" | "b"; extRef: string | null; passNo: number; amountMinor: string | null; currency: string | null; businessDate: string };
/**
 * One source for a break's pair (designer re-check 5, B2): its proposal (DEC-047), else the other side of the
 * suggestion it still holds (a suggestion day close broke keeps its group); null without either.
 */
export function breakPair(r: Pick<ReconRunItemDto, "side" | "proposed" | "group">): BreakPair | null {
  if (r.proposed) return r.proposed;
  const m = r.group?.members.find((x) => x.side !== r.side);
  return m && r.group ? { side: m.side, extRef: m.extRef, passNo: r.group.passNo, amountMinor: m.amountMinor, currency: m.currency, businessDate: m.businessDate } : null;
}
/**
 * What differs between side A's record and side B's (B − A) when no evidence was stored (a proposed pair, DEC-047):
 * "IDR vs USD" when the currencies differ, else "Amount +500.00" and/or "Date +1 day"; "" when nothing does.
 */
export function pairDifference(a: Rec, b: Rec): string {
  if (a.currency && b.currency && a.currency !== b.currency) return `${a.currency} vs ${b.currency}`;
  const parts: string[] = [];
  if (a.amountMinor !== null && b.amountMinor !== null) {
    const t = amountDelta(String(BigInt(b.amountMinor) - BigInt(a.amountMinor)), a.currency);
    if (t && BigInt(b.amountMinor) !== BigInt(a.amountMinor)) parts.push(`Amount ${t}`);
  }
  const days = (Date.parse(b.businessDate) - Date.parse(a.businessDate)) / 86_400_000;
  if (days) parts.push(`Date ${dayDelta(days)}`);
  return parts.join(" · ");
}

/**
 * Where a break without a counterpart could have found one (Explain): the other side's dates day close looked at, its
 * own date and up to carry over before it (engine sql/breaks.ts nearMissSql: o.bd between m.bd − carry and m.bd):
 * "2–3 Nov 2026" for 3 Nov with 1 day.
 */
export const counterpartWindow = (date: string, carry: number | null) =>
  carry === null ? `${rangeText(date, date)} or later` : rangeText(shiftDate(date, -carry), date);

/**
 * The other side's card in Explain for a break without a pair to show (no group, no proposal): what day close or the
 * pass found there, by the break's reason (engine sql/breaks.ts). No counterpart: "No item with reference … on 3–4 Nov
 * 2026." (Figma 206:6372).
 */
export function lonePairText(item: { extRef: string | null; businessDate: string; breakReason: string | null; breakPass: number | null }, carry: number | null): string {
  const ref = item.extRef ?? "—", on = counterpartWindow(item.businessDate, carry);
  switch (item.breakReason) {
    case "Duplicate": return `Reference ${ref} is on more than one item of a side, so pass ${item.breakPass ?? "—"} paired none of them.`;
    case "Ambiguous": return `Pass ${item.breakPass ?? "—"} found more than one candidate, so it paired none of them.`;
    case "Currency differs": return `An item with reference ${ref} on ${on} is in another currency.`;
    case "Amount differs": return `An item with reference ${ref} on ${on} differs in amount beyond the tolerance.`;
    case "Date differs": return `An item with reference ${ref} differs in date beyond the window.`;
    case "Unconfirmed suggestion": return "Its suggested pair wasn't confirmed before the day closed.";
    default: return `No item with reference ${ref} on ${on}.`;
  }
}

/**
 * Explain's sentence for a lone break (Figma 206:6372): "Carry over is 1 day, so a 4 Nov item is looked for on 3 and 4
 * Nov." The dates are day close's window, the item's date and the carry-over days before it.
 */
export function carryOverText(date: string, carry: number | null): string {
  const day = (d: string) => formatDate(appDayStart(d));
  if (carry === null) return `Carry over is always, so a ${day(date)} item is looked for on every run until it matches or is closed.`;
  const start = shiftDate(date, -carry), first = start.slice(0, 7) === date.slice(0, 7) ? String(Number(start.slice(8))) : day(start);
  const on = carry === 0 ? day(date) : carry === 1 ? `${first} and ${day(date)}` : `${first}–${day(date)}`;
  return `Carry over is ${carry} ${carry === 1 ? "day" : "days"}, so a ${day(date)} item is looked for on ${on}.`;
}

/** "2,000 items", or the one fact that the run found nothing new to take in. */
export const itemsText = (n: number) => (n ? `${formatNumber(n)} items` : "no new records");

/** "93.7%" (one decimal, as the design writes it), or "—". */
export const rateText = (rate: number | null) => (rate === null ? "—" : `${formatDecimal(rate * 100, 1)}%`);

/**
 * A count per side, named as the tiles name it: "7 src1 r2 · 8 src2 r2b waiting", or one number when both sides agree:
 * "24 waiting per side" (designer re-check 4: a pair never borrows the "·" between counts).
 */
export function sidesText(x: PerSide, labels: readonly [string, string], noun: string): string {
  return x.a === x.b ? `${formatNumber(x.a)} ${noun} per side` : `${formatNumber(x.a)} ${labels[0]} · ${formatNumber(x.b)} ${labels[1]} ${noun}`;
}

/**
 * "937 matched · 24 suggested (open) · 30 duplicate · 24 waiting per side · match rate 93.7%" (BUILDER-SPEC count
 * line, sides named per R4-1); breaks per side after waiting once there are any ("48 unmatch per side").
 */
export function countLine(t: Totals, labels: readonly [string, string]): string {
  const breaks = t.breaks && (t.breaks.a || t.breaks.b) ? [sidesText(t.breaks, labels, "unmatch")] : [];
  return [`${formatNumber(t.matched)} matched`, `${formatNumber(t.suggested)} suggested (open)`, `${formatNumber(t.duplicate)} duplicate`,
    ...(t.ambiguous ? [`${formatNumber(t.ambiguous)} ambiguous`] : []), sidesText(t.waiting, labels, "waiting"), ...breaks, `match rate ${rateText(t.rate)}`].join(" · ");
}

const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
export type SimView = { chip: { health: "healthy" | "degraded" | "unknown" | "down"; label: string }; line: string; counts: Run | null; dim: boolean };
/** A run that failed, as the bar and the run page say it: chip "Stopped", "The simulation stopped: <its reason>". */
export const STOPPED_CHIP = { health: "down" as const, label: "Stopped" };
export function stoppedLine(r: { mode: string; error: string | null }): string {
  return `The ${r.mode === "simulation" ? "simulation" : "run"} stopped: ${lowerFirst(r.error ?? "it ended before it finished. Run it again.")}`;
}
/**
 * The simulation bar of a draft (BUILDER-SPEC chips and lines): `run` = its latest simulation, `shown` = its latest one
 * that succeeded (its numbers stay, dimmed, while the next one runs or once the draft changed), `dirty` = edits not
 * saved yet.
 */
export function simView(v: Version, run: Run | null, shown: Run | null, dirty: boolean): SimView {
  const draft = `Draft v${v.version}`;
  if (run && isLive(run)) return { chip: { health: "unknown", label: "Running" }, line: `${draft} · ${rangeText(run.from, run.to)}`, counts: shown, dim: true };
  if (run?.status === "failed") {
    return { chip: STOPPED_CHIP, line: stoppedLine(run), counts: null, dim: false };
  }
  if (v.simulatedHash === null || !shown) return { chip: { health: "unknown", label: "Not simulated" }, line: `${draft} · not simulated yet`, counts: null, dim: false };
  // a run carries the matching hash (no approval setup): an approval-only edit leaves it current
  if (dirty || v.simulatedHash !== v.matchingHash || shown.specHash !== v.matchingHash) {
    return { chip: { health: "degraded", label: "Out of date" }, line: "The draft changed after the last simulation", counts: shown, dim: true };
  }
  const items = shown.counters.intake.a - shown.counters.replaced.a + shown.counters.intake.b - shown.counters.replaced.b;
  const at = shown.finishedAt ? ` · ${formatTime(Date.parse(shown.finishedAt))} ${APP_TIME_ZONE_LABEL}` : "";
  return { chip: { health: "healthy", label: "Simulated" }, line: `${draft} · ${rangeText(shown.from, shown.to)} · ${itemsText(items)}${at}`, counts: shown, dim: false };
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

export { amountText } from "@/lib/shared/amount";

/** A business date of a run in the strip: groups matched and suggested, items broken by label, items waiting per side. */
export function dayTotals(day: Pick<RunDay, "passes" | "open"> & Partial<Pick<RunDay, "breaks" | "closed">>, spec: ReconSpec) {
  let matched = 0, suggested = 0, duplicate = 0, ambiguous = 0;
  for (const p of spec.passes) {
    const x = day.passes[String(p.no)];
    if (!x) continue;
    matched += x.matched;
    suggested += x.suggested;
    if (breakLabel(p) === "Duplicate") duplicate += x.broken; else ambiguous += x.broken;
  }
  return { matched, suggested, duplicate, ambiguous, waiting: day.open, breaks: day.breaks ?? null, closed: !!day.closed };
}

/** Each pass's groups and broken items over all of a run's dates as they stand now (the pass tabs under "All dates"). */
export function dayPasses(days: readonly Pick<RunDay, "passes">[]): RunDay["passes"] {
  const out: RunDay["passes"] = {};
  for (const d of days) for (const [no, x] of Object.entries(d.passes)) {
    const o = (out[no] ??= { matched: 0, suggested: 0, broken: 0, brokenRefs: 0 });
    o.matched += x.matched; o.suggested += x.suggested; o.broken += x.broken; o.brokenRefs += x.brokenRefs;
  }
  return out;
}

/** Day close's reason for a pair that only the currency keeps apart: a card of its own in the builder (BUILDER-SPEC). */
export const CURRENCY_DIFFERS = "Currency differs";
/** Day close's reason for an item nothing on the other side could pair. */
export const NO_COUNTERPART = "No counterpart";
/** Day close's reasons in the order they read best (day close's classifier, engine sql/breaks.ts NEAR_MISS). */
const REASON_TEXT: readonly (readonly [string, string])[] = [
  ["Currency differs", "currency differs"], ["Amount differs", "amount outside tolerance"], ["Date differs", "date differs"], ["No counterpart", "no counterpart"],
];
type Sides = readonly [string, string];
/** "3", or "3 source1 · 2 source2" when the sides differ. */
const perSide = (a: number, b: number, labels: Sides) => (a === b ? formatNumber(a) : `${formatNumber(a)} ${labels[0]} · ${formatNumber(b)} ${labels[1]}`);
/** Reasons the web doesn't know yet: told once to the console, never printed raw. */
const unknownSeen = new Set<string>();
/**
 * What day close would do with a simulation's waiting items and unconfirmed suggestions (Captain): "3 currency differs
 * · 1 amount outside tolerance · 20 no counterpart · 24 unconfirmed suggestions"; one number when both sides agree,
 * per side otherwise; `skip` leaves reasons out (a card of their own). "" when nothing would break.
 */
export function projectionText(p: Pick<RunProjection, "a" | "b" | "unconfirmed">, labels: Sides, skip: readonly string[] = []): string {
  for (const k of new Set([...Object.keys(p.a), ...Object.keys(p.b)])) {
    if (REASON_TEXT.some(([r]) => r === k) || unknownSeen.has(k)) continue;
    unknownSeen.add(k);
    console.warn(`Day close reason without a text on screen: ${k}`);
  }
  const parts = REASON_TEXT.filter(([k]) => !skip.includes(k) && ((p.a[k] ?? 0) || (p.b[k] ?? 0))).map(([k, t]) => `${perSide(p.a[k] ?? 0, p.b[k] ?? 0, labels)} ${t}`);
  const u = p.unconfirmed;
  if (u && (u.a || u.b)) parts.push(`${perSide(u.a, u.b, labels)} unconfirmed ${u.a === 1 && u.b === 1 ? "suggestion" : "suggestions"}`);
  return parts.join(" · ");
}
/** One reason's count as a card says it: "3 pairs" when both sides agree, else per side. */
export function reasonCount(p: { a: Record<string, number>; b: Record<string, number> }, reason: string, labels: readonly [string, string]): string | null {
  const a = p.a[reason] ?? 0, b = p.b[reason] ?? 0;
  if (!a && !b) return null;
  return a === b ? `${formatNumber(a)} ${a === 1 ? "pair" : "pairs"}` : `${formatNumber(a)} ${labels[0]} · ${formatNumber(b)} ${labels[1]}`;
}
