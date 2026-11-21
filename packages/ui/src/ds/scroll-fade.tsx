"use client";

import * as React from "react";
import { cn } from "../lib/cn";

/** A side of a box with content hidden past it right now (its scroll position, re-read on resize). */
type Edges = { top: boolean; bottom: boolean; left: boolean; right: boolean };
const NONE: Edges = { top: false, bottom: false, left: false, right: false };

/** The scroll box's hidden sides, re-read on scroll and on a resize of it or its content. */
function useEdges<T extends HTMLElement>(): [React.RefCallback<T>, Edges] {
  const [el, setEl] = React.useState<T | null>(null);
  const [edges, setEdges] = React.useState<Edges>(NONE);
  React.useEffect(() => {
    if (!el) return;
    const check = () => {
      // a pixel of slack: zoom and subpixel sizes leave a fraction at the end
      const y = el.scrollHeight - el.clientHeight, x = el.scrollWidth - el.clientWidth;
      const next = { top: el.scrollTop > 1, bottom: y - el.scrollTop > 1, left: Math.abs(el.scrollLeft) > 1, right: x - Math.abs(el.scrollLeft) > 1 };
      setEdges((e) => (e.top === next.top && e.bottom === next.bottom && e.left === next.left && e.right === next.right ? e : next));
    };
    check();
    el.addEventListener("scroll", check, { passive: true });
    if (typeof ResizeObserver === "undefined") return () => el.removeEventListener("scroll", check);
    const ro = new ResizeObserver(check);
    ro.observe(el);
    for (const c of Array.from(el.children)) ro.observe(c);
    return () => { ro.disconnect(); el.removeEventListener("scroll", check); };
  }, [el]);
  return [setEl, edges];
}

/** The same fade as a table's sideways scroll (design-system §5.7): --line through --tray to clear, DS surfaces only. */
const FADE = "pointer-events-none absolute z-20 from-line via-tray to-transparent opacity-0 transition-opacity duration-(--dur-fast) data-[on]:opacity-100";

/**
 * A box that scrolls, on either axis, with a fade on each side that has content hidden past it (owner rule, 21 Nov:
 * every region that scrolls shows where it goes on). `className` sizes the box (it scrolls inside); the fades sit on
 * it and never take a pointer. Decoration only: the box keeps its own role and label.
 */
export function ScrollFade({ className, children, ...props }: React.ComponentProps<"div">) {
  const [ref, e] = useEdges<HTMLDivElement>();
  return (
    <div data-slot="scroll-fade" className="relative h-full min-h-0 min-w-0">
      <div ref={ref} className={cn("scroll-quiet overflow-auto", className)} {...props}>{children}</div>
      <span aria-hidden="true" data-slot="scroll-fade-edge" data-side="top" data-on={e.top || undefined} className={cn(FADE, "inset-x-0 top-0 h-8 bg-linear-to-b")} />
      <span aria-hidden="true" data-slot="scroll-fade-edge" data-side="bottom" data-on={e.bottom || undefined} className={cn(FADE, "inset-x-0 bottom-0 h-8 bg-linear-to-t")} />
      <span aria-hidden="true" data-slot="scroll-fade-edge" data-side="left" data-on={e.left || undefined} className={cn(FADE, "inset-y-0 left-0 w-12 bg-linear-to-r")} />
      <span aria-hidden="true" data-slot="scroll-fade-edge" data-side="right" data-on={e.right || undefined} className={cn(FADE, "inset-y-0 right-0 w-12 bg-linear-to-l")} />
    </div>
  );
}
