"use client";

import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { Icon, type IconData } from "../ui/icon";
import { ArrowDownIcon, ArrowUpIcon } from "../ui/icons";
import { cn } from "../lib/cn";
import { NumberTween } from "../motion";
import { Skeleton } from "../ui/skeleton";
import { clampRatio } from "../lib/meter";
import { type DeltaDirection, deltaTone, splitDelta } from "../lib/delta";
import { formatCompact } from "../lib/format";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

/** A plain number as format.ts prints it: optional sign, grouped digits, optional decimals. */
const NUMBER = /^[-−]?\d{1,3}(,\d{3})*(\.\d+)?$/;
/** Past this many characters a number is wider than a tile at 1440 px (5 tiles in a row). */
const FITS = 10;

/**
 * A KPI value never wider than its tile (audit 2 A11): a plain number longer than FITS characters shows compact
 * ("140.9B"), the exact text kept for the tooltip and screen readers; anything else (a count, "3 of 7") as it is.
 * `force` compacts a shorter number too: the tile measured it wider than itself (a phone, 2 tiles a row).
 */
export function fitStat(value: string, force = false): { shown: string; exact: string | null } {
  if (!NUMBER.test(value) || (!force && value.length <= FITS)) return { shown: value, exact: null };
  const shown = formatCompact(Number(value.replace(/,/g, "").replace("−", "-")));
  return shown === value ? { shown, exact: null } : { shown, exact: value };
}

/**
 * `text` is the whole comparison, number first ("+18% vs previous 24 hours"): the number goes in the pill and the
 * rest in the caption. A text that is not number-first is a caption without a pill. `good` = the direction that is
 * good for this metric (cost up = bad); null = neutral.
 */
export type Delta = { text: string; direction: DeltaDirection; good: "up" | "down" | null };

const PILL = { good: "bg-healthy-soft text-healthy-ink", bad: "bg-down-soft text-down-ink", neutral: "bg-tray text-fg-2" } as const;

/**
 * KPI tray (spec §5.5): one tray, tiles side by side with a 4 px gap, always filling the row (4 or 3 equal tiles
 * at ≥ 1024, 2 per row below). Tiles enter staggered (CSS, 35 ms per tile).
 */
export function StatTiles({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div data-slot="kpi-tray" className={cn("stagger-children grid grid-cols-2 gap-tray rounded-xl border border-line bg-tray p-tray lg:auto-cols-fr lg:grid-flow-col lg:grid-cols-none", className)}>
      {children}
    </div>
  );
}

/**
 * KPI tile (spec §5.5): card, padding 16, min-height 104. Label row (16 px fg-3 icon + body-sm fg-2) with the
 * delta pill right; value `stat` 28/500 with the unit / denominator in body fg-3; then the comparison caption and
 * an optional 6 px striped progress bar or a 28 px sparkline (`trend`). `caption` replaces the comparison line
 * under the value (with or without a delta, e.g. "Last 7 days · vs previous 7 days" or "1,204 tokens today"). `tween` animates value changes
 * (NumberTween; `value` stays the fallback text and is ignored while `tween` is set). `onSelect` makes the tile a
 * toggle button (`aria-pressed` = `selected`, primary edge while selected): a tile that filters the list below it.
 */
export function StatTile({ label, value, unit, delta, caption: captionProp, trend, icon, progress, tween, onSelect, selected }: {
  label: string; value: string; unit?: string; delta?: Delta; caption?: string; trend?: ReactNode; icon?: IconData;
  /** 0–1: 6 px striped bar under the value (e.g. 19 of 24 connected). */
  progress?: number | null;
  tween?: { value: number; format: (v: number) => string; total?: number };
  onSelect?: () => void; selected?: boolean;
}) {
  const split = delta ? splitDelta(delta.text) : null;
  const pill = split?.pill ?? null;
  const caption = captionProp ?? split?.caption ?? null;
  const tone = delta ? deltaTone(delta) : "neutral";
  const arrow = delta?.direction === "up" ? ArrowUpIcon : delta?.direction === "down" ? ArrowDownIcon : null;
  const Root = onSelect ? "button" : "div";
  return (
    <Root data-slot="stat-tile" {...(onSelect ? { type: "button" as const, onClick: onSelect, "aria-pressed": !!selected } : {})}
      className={cn("flex min-h-26 min-w-0 flex-col gap-2.5 rounded-lg border bg-card p-4 text-left",
        selected ? "border-primary" : "border-line",
        onSelect && "card-lift cursor-pointer outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-primary")}>
      <div className="flex min-w-0 items-center gap-2 text-body-sm text-fg-2">
        {icon && <Icon icon={icon} className="size-4 shrink-0 text-fg-3" />}
        <span className="min-w-0 truncate" title={label}>{label}</span>
        {pill && (
          <span className={cn("-my-0.5 ml-auto inline-flex h-5 shrink-0 items-center gap-0.5 rounded-full px-1.5 text-label", PILL[tone])}>
            {arrow && <Icon icon={arrow} className="size-3" />}{pill}
          </span>
        )}
      </div>
      <StatValue value={value} unit={unit} tween={tween} nested={!!onSelect} />
      {progress != null && (
        <span aria-hidden="true" className="block h-1.5 overflow-hidden rounded-full bg-inset">
          <span className="striped block h-full rounded-full bg-primary" style={{ width: `${clampRatio(progress) * 100}%` }} />
        </span>
      )}
      {caption && <span className="text-caption text-fg-3">{caption}</span>}
      {trend && <div className="mt-auto h-7">{trend}</div>}
    </Root>
  );
}

/**
 * The value line; a plain number that doesn't fit the tile turns compact (fitStat), its exact value one focus, hover or
 * tap away: a button drawn as the text opens the tooltip (review 24 Nov: a title reaches neither touch nor keyboard).
 * Inside a tile that is a button itself (`nested`, onSelect) no button may nest: the exact value stays in the title.
 * Screen readers read the exact value either way.
 */
function StatValue({ value, unit, tween, nested }: { value: string; unit?: string; tween?: { value: number; format: (v: number) => string; total?: number }; nested?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  const need = useRef(0);
  const [force, setForce] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || tween || typeof ResizeObserver === "undefined") return;
    // the full text wider than the tile: compact, remembering its width; the tile grown to that width again: full
    const check = () => {
      if (el.dataset.compact) { if (need.current && el.clientWidth >= need.current) setForce(false); }
      else if (el.scrollWidth > el.clientWidth) { need.current = el.scrollWidth; setForce(true); }
    };
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [tween, value]);
  const fit = tween ? { shown: value, exact: null } : fitStat(value, force);
  const exactText = fit.exact ? `${fit.exact}${unit ? ` ${unit}` : ""}` : null;
  const trigger = fit.exact && !nested;
  const unitText = unit && <span aria-hidden={trigger || undefined} className="ml-0.5 text-body font-normal tracking-normal text-fg-3">{unit}</span>;
  return (
    <span ref={ref} data-compact={fit.exact ? "true" : undefined} className="min-w-0 text-stat whitespace-nowrap text-fg tabular" title={fit.exact && nested ? exactText! : undefined}>
      {tween ? <NumberTween value={tween.value} format={tween.format} total={tween.total} />
        : trigger ? (
          <Tooltip open={open} onOpenChange={setOpen}>
            <TooltipTrigger asChild>
              {/* a tap opens it too (Radix closes a tooltip on click): the press is ours, outside presses and Escape close it */}
              <button type="button" data-slot="stat-exact" onClick={(e) => { e.preventDefault(); setOpen(true); }}
                className="cursor-help rounded-xs outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-primary">
                <span aria-hidden="true">{fit.shown}</span><span className="sr-only">{exactText}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent className="tabular">{exactText}</TooltipContent>
          </Tooltip>
        )
        : fit.exact ? <><span aria-hidden="true">{fit.shown}</span><span className="sr-only">{fit.exact}</span></> : value}
      {unitText}
    </span>
  );
}

/**
 * Loading shape for `count` tiles — the StatTile rows at their rendered heights (label 18, value 32, optional 6 px
 * bar, caption 16, optional 28 px trend; gap 10), so the tray keeps its height when the values arrive (no layout
 * shift). Match the loaded tiles: `progress` when one has a bar, `caption={false}` when none has a caption line.
 */
export function StatTileSkeletons({ count = 4, trend = false, caption = true, progress = false }: { count?: number; trend?: boolean; caption?: boolean; progress?: boolean }) {
  return Array.from({ length: count }, (_, i) => (
    <div key={i} className="flex min-h-26 flex-col gap-2.5 rounded-lg border border-line bg-card p-4" aria-hidden="true">
      <div className="flex h-4.5 items-center"><Skeleton className="h-2.5 w-1/2" /></div>
      <div className="flex h-8 items-center"><Skeleton className="h-7 w-1/3" /></div>
      {progress && <Skeleton className="h-1.5 w-full rounded-full" />}
      {caption && <div className="flex h-4 items-center"><Skeleton className="h-2.5 w-2/3" /></div>}
      {trend && <Skeleton className="mt-auto h-7 w-full" />}
    </div>
  ));
}
