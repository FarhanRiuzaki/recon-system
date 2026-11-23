"use client";

import * as React from "react";
import { cn } from "../lib/cn";

/**
 * True while the element is wider inside than its box (it scrolls sideways): such a box must be reachable by keyboard
 * (a named, focusable region; axe scrollable-region-focusable), and only then, so a table that fits adds no tab stop.
 * `edges`: whether content is hidden past the start or the end right now (the scroll position), for the edge fades.
 */
export function useScrollsX<T extends HTMLElement>(): [React.RefCallback<T>, boolean, boolean, { start: boolean; end: boolean }] {
  const [el, setEl] = React.useState<T | null>(null);
  const [scrolls, setScrolls] = React.useState(false);
  const [measured, setMeasured] = React.useState(false);
  const [edges, setEdges] = React.useState({ start: false, end: false });
  React.useEffect(() => {
    if (!el) return;
    const check = () => {
      const over = el.scrollWidth - el.clientWidth;
      setScrolls(over > 0);
      setMeasured(true);
      // a pixel of slack: zoom and subpixel widths leave a fraction at the end
      const start = Math.abs(el.scrollLeft) > 1, end = over - Math.abs(el.scrollLeft) > 1;
      setEdges((e) => (e.start === start && e.end === end ? e : { start, end }));
    };
    check();
    el.addEventListener("scroll", check, { passive: true });
    if (typeof ResizeObserver === "undefined") return () => el.removeEventListener("scroll", check);
    const ro = new ResizeObserver(check);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => { ro.disconnect(); el.removeEventListener("scroll", check); };
  }, [el]);
  return [setEl, scrolls, measured, edges];
}

/** First and last cell 16 px from the card edge from 768 px (audit 2 A2); a phone card row sets its own padding. */
export const TABLE_INSET = "md:[&_tr>*:first-child]:pl-4 md:[&_tr>*:last-child]:pr-4";

/** The fade on a side of a sideways-scrolling box while content is hidden past it (owner, 21 Nov): the row divider's --line through the tray surface to clear: DS surfaces only, visible on a white card. */
const FADE = "pointer-events-none absolute inset-y-0 z-20 w-12 from-line via-tray to-transparent opacity-0 transition-opacity duration-(--dur-fast) data-[on]:opacity-100";

/**
 * Table (spec §5.7): header 40 px on the tray tint, rows --row-h (44 / compact 36), 1 px dividers, no zebra, no vertical rules.
 * Wider than the screen (a phone), it scrolls sideways inside its card; the box is then a focusable region named after the table.
 * Once measured to fit, the box stops being a scroll container (overflow visible), so a sticky header sticks to the
 * window; `data-scrolls` (group `scroll`) lets cells stick to the box's sides while it scrolls sideways (DataTable).
 * While it scrolls, each side with hidden content shows a fade (design-system §5.7), so the table reads as wider; a table
 * whose first column sticks sets `--table-stick` (its width) on an ancestor, so the start fade begins past that column.
 * From 768 px the first and last cell of every row sit 16 px from the card edge (audit 2 A2), so the first column's
 * text lines up with the panel title above the card; the cells between keep 12.
 */
function Table({ className, ...props }: React.ComponentProps<"table">) {
  const [ref, scrolls, measured, edges] = useScrollsX<HTMLDivElement>();
  return (
    <div data-slot="table-frame" className="relative w-full min-w-0">
      <div ref={ref} data-slot="table-container" data-scrolls={scrolls || undefined}
        className={cn("group/scroll relative w-full", measured && !scrolls ? "overflow-x-visible" : "scroll-quiet overflow-x-auto")}
        {...(scrolls ? { tabIndex: 0, role: "region", "aria-label": props["aria-label"] } : {})}>
        <table data-slot="table" className={cn(TABLE_INSET, "w-full border-separate border-spacing-0 text-body", className)} {...props} />
      </div>
      {/* more to see on that side: a grey edge fading to clear, shown only while content is hidden past it */}
      {scrolls && <span aria-hidden="true" data-slot="table-fade" data-side="start" data-on={edges.start || undefined} className={cn(FADE, "left-[var(--table-stick,0px)] bg-linear-to-r")} />}
      {scrolls && <span aria-hidden="true" data-slot="table-fade" data-side="end" data-on={edges.end || undefined} className={cn(FADE, "right-0 bg-linear-to-l")} />}
    </div>
  );
}
function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("bg-tray", className)} {...props} />;
}
function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={cn("[&_tr:last-child_td]:border-b-0", className)} {...props} />;
}
function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return <tfoot data-slot="table-footer" className={cn("bg-tray font-medium", className)} {...props} />;
}
function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return <tr data-slot="table-row" className={cn("group/row transition-colors duration-(--dur-instant) hover:bg-tray/60 data-[expanded]:[&>*]:border-b-0 data-[state=selected]:bg-row-selected data-[state=selected]:[&>td:first-child]:row-mark", className)} {...props} />;
}
function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return <th data-slot="table-head" className={cn("h-10 border-b border-line px-3 text-left align-middle text-label font-normal whitespace-nowrap text-fg-3", className)} {...props} />;
}
/**
 * A body cell: long text wraps in the column instead of being cut (Captain, 21 Nov 2026), also inside a `Truncate` or
 * a `truncate` span in the cell (its ellipsis is off here); a cell that must stay on one line passes `whitespace-nowrap`.
 * A chip never wraps (audit 2 A10): its label stays one line, so the chip's width is the column's minimum.
 */
export const CHIP_NOWRAP = "[&_[data-slot$=chip]]:whitespace-nowrap [&_[data-slot$=chip]_.truncate]:overflow-hidden [&_[data-slot$=chip]_.truncate]:whitespace-nowrap [&_[data-slot$=chip]_.truncate]:break-normal";
export const CELL_WRAP = `whitespace-normal break-words [&_.truncate]:overflow-visible [&_.truncate]:whitespace-normal [&_.truncate]:break-words ${CHIP_NOWRAP}`;
function TableCell({ className, ...props }: React.ComponentProps<"td">) {
  return <td data-slot="table-cell" className={cn("h-(--row-h) border-b border-line px-3 py-1.5 align-middle", CELL_WRAP, className)} {...props} />;
}
/**
 * The panel a row opens in place under it (an editor, the row's details), one cell across every column (audit 2 A4):
 * 12 px under the row, 16 px from the card's sides and above the next row's line. The row that opened it passes
 * `data-expanded` so its own line goes and the two read as one; the line under this one closes them.
 */
function TableExpandRow({ colSpan, className, children, ...props }: React.ComponentProps<"tr"> & { colSpan: number }) {
  return (
    <tr data-slot="table-expand-row" {...props}>
      <td colSpan={colSpan} className={cn("border-b border-line px-expand pt-expand-top pb-expand align-top", className)}>{children}</td>
    </tr>
  );
}
function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return <caption data-slot="table-caption" className={cn("mt-3 text-label font-normal text-fg-3", className)} {...props} />;
}

export { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell, TableCaption, TableExpandRow };
