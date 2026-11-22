import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * A page zone (audit P2, design-system.md §5.19): an eyebrow heading over the panels of one part of a page (Summary,
 * Act, History), the panels 16 px apart (`--gap-grid`, class `gap-gutter`). Zones stack 40 px apart: put them in `grid gap-zone`
 * (`--gap-zone`), so the eye reads a zone as one group before the next.
 */
export function PageZone({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  return (
    <section data-slot="page-zone" className={cn("grid min-w-0 gap-gutter", className)}>
      <h2 className="eyebrow text-fg-3">{title}</h2>
      {children}
    </section>
  );
}
