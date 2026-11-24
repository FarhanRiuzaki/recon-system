"use client";

import { useEffect, useState } from "react";
import { cn } from "../lib/cn";
import { usePrefersReducedMotion } from "../motion/reduced-motion";
import { EASE, tweenDuration } from "../motion/tokens";
import { bezier, runTween } from "../motion/tween";

export type LiveCountTone = "neutral" | "progress" | "down";
/** neutral: the plain count badge; progress: waiting on the viewer (the in-progress blue); down: a failure (Down's soft fill). */
const TONE: Record<LiveCountTone, string> = { neutral: "bg-tray text-fg-2", progress: "bg-progress-soft text-progress-ink", down: "bg-down-soft text-down-ink" };
const easeOut = bezier(...EASE.out);

type LiveState = { value: number; from: number; n: number };
/** Pure: the first value is the baseline (n 0); each later change adds 1 to n and keeps the value it came from. */
export function nextLiveCount(prev: LiveState | null, value: number): LiveState {
  if (!prev) return { value, from: value, n: 0 };
  return prev.value === value ? prev : { value, from: prev.value, n: prev.n + 1 };
}

/**
 * A count that updates live (the sidebar's): the CountBadge pill in a tone. It fades in on its first render; on each
 * later change it pops once (`animate-pop`, R5) while the number rolls from the old value (NumberTween's engine,
 * `runTween`, without the Framer layer: the sidebar is in every route's first load); reduced motion, a plain fade and
 * no roll. 0 renders nothing but keeps the baseline, so a count coming back pops. Hidden from screen readers (the
 * owner names the count, e.g. in its link; changes are not announced); `title` the full number.
 */
export function LiveCountBadge({ value, format, tone = "neutral", title, className }: {
  value: number; format: (v: number) => string; tone?: LiveCountTone; title?: string; className?: string;
}) {
  // state derived from the previous render (React's "storing information from previous renders")
  const [st, setSt] = useState(() => nextLiveCount(null, value));
  const next = nextLiveCount(st, value);
  if (next !== st) setSt(next);
  const { n, from } = next;
  const reduced = usePrefersReducedMotion();
  const [shown, setShown] = useState(value);
  useEffect(() => runTween({ from, to: value, seconds: n ? tweenDuration(from, value, undefined, reduced) : 0, ease: easeOut, onFrame: setShown }),
    // a new value starts the roll; a change of the motion setting mid-roll doesn't restart it
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [value]);
  if (!value) return null;
  return (
    <span key={n} data-slot="live-count" aria-hidden="true" title={title} className={cn("inline-flex", n ? "animate-pop" : "animate-fade", className)}>
      {/* CountBadge's pill (ds/badges), drawn here so the shell loads no chip code */}
      <span data-slot="count-badge" className={cn("inline-flex h-4.5 min-w-4.5 shrink-0 items-center justify-center rounded-full px-1.5 text-label tabular", TONE[tone])}>{format(n ? shown : value)}</span>
    </span>
  );
}
