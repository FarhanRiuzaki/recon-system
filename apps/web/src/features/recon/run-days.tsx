"use client";

import { formatNumber } from "@starterkit/ui/lib/format";
import type { ReconRunDto, ReconSpec, RunDay } from "@starterkit/shared/contracts/recon";
import { type Breaks, breaksOf, breaksText, dayPasses, dayTotals, rangeText, runDays, sidesText, standingTotals } from "./run-model";

type PerSide = { a: number; b: number };

type Labels = readonly [string, string];
/** One tile of a run's date strip: "" = All dates (the run's own dates as they stand), CARRIED, else a business date. */
export type DayTile = { date: string; t: ReturnType<typeof dayTotals>; b: Breaks | null };
/** The Carried over tile's date: the carry-over dates before the run's, as one (the URL's `carried`). */
export const CARRIED = "carried";

const add = (x: PerSide, y: PerSide): PerSide => ({ a: x.a + y.a, b: x.b + y.b });
/**
 * The carry-over dates before the run's own (its days before `from`) summed into one day, the Carried over tile and
 * the tabs' counts under it; null when there are none.
 */
export function carriedDay(run: Pick<ReconRunDto, "days" | "from">): RunDay | null {
  const days = (run.days ?? []).filter((d) => d.date < run.from);
  if (!days.length) return null;
  const zero = { a: 0, b: 0 };
  const breakReasons: Record<string, PerSide> = {};
  for (const d of days) for (const [reason, n] of Object.entries(d.breakReasons ?? {})) breakReasons[reason] = add(breakReasons[reason] ?? zero, n);
  return {
    date: CARRIED, passes: dayPasses(days), open: days.reduce((n, d) => add(n, d.open), zero), breaks: days.reduce((n, d) => add(n, d.breaks), zero),
    ...(days.every((d) => d.items) ? { items: days.reduce((n, d) => add(n, d.items!), zero) } : {}),
    ...(days.every((d) => d.breakReasons) ? { breakReasons } : {}),
    closed: days.every((d) => d.closed),
  };
}

/** A run's tiles: All dates, Carried over when it has any, then each of its own dates; a real run's breaks by the one definition (Duplicate included). */
export function dayTilesOf(run: ReconRunDto, spec: ReconSpec): DayTile[] {
  const real = run.mode !== "simulation";
  const all = standingTotals(run, spec);
  const carried = carriedDay(run);
  return [
    { date: "", t: { ...all, breaks: all.breaks, closed: false }, b: real ? breaksOf(run.live?.breakReasons) : null },
    ...[...(carried ? [carried] : []), ...runDays(run)].map((d) => ({ date: d.date, t: dayTotals(d, spec), b: real ? breaksOf(d.breakReasons) : null })),
  ];
}
/** "2 Nov", "Carried over", or "All dates". */
export const dayLabel = (date: string) => (date === CARRIED ? "Carried over" : date ? rangeText(date, date).replace(/ \d{4}$/, "") : "All dates");
/** A tile's breaks: by the one definition when the API counts them by reason, else the breaks of time it has; "" for none. */
export function tileBreaks({ t, b }: DayTile, labels: Labels): string {
  if (b) return b.breaks.a || b.breaks.b ? breaksText(b, labels) : "";
  return t.breaks && (t.breaks.a || t.breaks.b) ? sidesText(t.breaks, labels, "unmatch") : "";
}
/** The phone select's option text of a tile. */
export const tileOption = (x: DayTile, labels: Labels) =>
  `${dayLabel(x.date)}${x.t.closed ? " · closed" : ""} · ${formatNumber(x.t.matched)} matched · ${formatNumber(x.t.suggested)} suggested${tileBreaks(x, labels) ? ` · ${tileBreaks(x, labels)}` : ""}`;
