"use client";

import { type ReactNode, useId } from "react";
import { cn } from "../lib/cn";
import { Panel } from "./panel";
import { ScrollFade } from "./scroll-fade";

export type CompareRow = { label: string; a: ReactNode; b: ReactNode; delta?: ReactNode; differs: boolean };

/**
 * Two sides of one comparison and what differs (audit P8, design-system.md §5.19): a table with a row per field,
 * one column per side and a difference column. A row that differs has a 2 px `--line-strong` rule on its left and
 * bold values, and says "differs" to a screen reader. Wider than its card, it scrolls inside it with the fades, and the
 * scroll box takes focus so a keyboard can scroll it; the table and the box are named by the card's title (a caption).
 * `sides` names the two columns ("Bank statement", "Ledger").
 */
export function CompareCard({ title, sides, rows, deltaLabel = "Difference", className }: {
  title: ReactNode; sides: readonly [string, string]; rows: readonly CompareRow[]; deltaLabel?: string; className?: string;
}) {
  const showDelta = rows.some((r) => r.delta != null);
  const id = useId();
  return (
    <Panel title={title} flush className={className}>
      <ScrollFade focusable aria-labelledby={id}>
        <table className="w-full text-body-sm">
          <caption className="sr-only" id={id}>{title}</caption>
          <thead>
            <tr className="border-b border-line text-left text-label text-fg-3">
              <th scope="col" className="border-l-2 border-l-transparent px-3 py-2 font-normal"><span className="sr-only">Field</span></th>
              {sides.map((s) => <th key={s} scope="col" className="px-3 py-2 font-normal">{s}</th>)}
              {showDelta && <th scope="col" className="px-3 py-2 font-normal">{deltaLabel}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, n) => (
              <tr key={`${n}:${r.label}`} data-differs={r.differs || undefined} className="border-b border-line last:border-b-0">
                <th scope="row" className={cn("border-l-2 px-3 py-2 text-left font-normal text-fg-2", r.differs ? "border-l-line-strong" : "border-l-transparent")}>
                  {r.label}{r.differs && <span className="sr-only">, differs</span>}
                </th>
                {[r.a, r.b].map((v, i) => <td key={i} className={cn("px-3 py-2 tabular text-fg", r.differs && "font-semibold")}>{v}</td>)}
                {showDelta && <td className={cn("px-3 py-2 tabular", r.differs ? "font-semibold text-fg" : "text-fg-3")}>{r.delta}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollFade>
    </Panel>
  );
}
