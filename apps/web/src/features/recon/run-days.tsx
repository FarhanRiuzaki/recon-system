"use client";

import Link from "next/link";
import type { MouseEvent } from "react";
import { cn } from "@starterkit/ui/lib/cn";
import { formatNumber } from "@starterkit/ui/lib/format";
import type { ReconRunDto, ReconSpec } from "@starterkit/shared/contracts/recon";
import { type Breaks, breaksOf, breaksText, dayTotals, rangeText, runDays, sidesText, standingTotals } from "./run-model";

type Labels = readonly [string, string];
/** One tile of a run's date strip: "" = All dates (the run's own dates as they stand), else a business date. */
export type DayTile = { date: string; t: ReturnType<typeof dayTotals>; b: Breaks | null };

/** A run's tiles: All dates, then each of its days; a real run's breaks by the one definition (Duplicate included). */
export function dayTilesOf(run: ReconRunDto, spec: ReconSpec, { own = false } = {}): DayTile[] {
  const real = run.mode !== "simulation";
  const all = standingTotals(run, spec);
  // `own`: the run's own dates only (the Overview), without the carry-over date before them
  const days = own ? runDays(run) : (run.days ?? []);
  return [
    { date: "", t: { ...all, breaks: all.breaks, closed: false }, b: real ? breaksOf(run.live?.breakReasons) : null },
    ...days.map((d) => ({ date: d.date, t: dayTotals(d, spec), b: real ? breaksOf(d.breakReasons) : null })),
  ];
}
/** "2 Nov", or "All dates". */
export const dayLabel = (date: string) => (date ? rangeText(date, date).replace(/ \d{4}$/, "") : "All dates");
/** A tile's breaks: by the one definition when the API counts them by reason, else the breaks of time it has; "" for none. */
export function tileBreaks({ t, b }: DayTile, labels: Labels): string {
  if (b) return b.breaks.a || b.breaks.b ? breaksText(b, labels) : "";
  return t.breaks && (t.breaks.a || t.breaks.b) ? sidesText(t.breaks, labels, "unmatch") : "";
}
/** The phone select's option text of a tile. */
export const tileOption = (x: DayTile, labels: Labels) =>
  `${dayLabel(x.date)}${x.t.closed ? " · closed" : ""} · ${formatNumber(x.t.matched)} matched · ${formatNumber(x.t.suggested)} suggested${tileBreaks(x, labels) ? ` · ${tileBreaks(x, labels)}` : ""}`;

/**
 * A run's date strip (run page, a recon's Overview): a tile per business date with what stands there; each a link
 * (`link(date)`: its href, an in-page handler, whether it is the picked one).
 */
export function RunDayTiles({ tiles, labels, link, className }: {
  tiles: readonly DayTile[]; labels: Labels; className?: string;
  link: (date: string) => { href: string; onClick?: (e: MouseEvent) => void; current?: boolean };
}) {
  return (
    <div role="group" aria-label="Business dates" className={cn("grid gap-2 md:grid-cols-3 xl:grid-cols-5", className)}>
      {tiles.map((x) => {
        const { href, onClick, current } = link(x.date);
        return (
          <Link key={x.date || "all"} href={href} onClick={onClick} aria-current={current ? "true" : undefined}
            className={cn("grid gap-0.5 rounded-md border bg-card p-2.5 text-left text-caption text-fg-3 tabular focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary",
              current ? "border-fg shadow-sm" : "border-line hover:bg-tray")}>
            <span className="text-label text-fg">{dayLabel(x.date)}{x.t.closed ? " · closed" : ""}</span>
            {/* a real run's duplicates are breaks (one definition); a simulation's stay its pass's duplicates */}
            <span>{formatNumber(x.t.matched)} matched · {formatNumber(x.t.suggested)} suggested{!x.b && x.t.duplicate ? ` · ${formatNumber(x.t.duplicate)} duplicate` : ""}</span>
            <span>{sidesText(x.t.waiting, labels, "waiting")}</span>
            {tileBreaks(x, labels) && <span>{tileBreaks(x, labels)}</span>}
          </Link>
        );
      })}
    </div>
  );
}
