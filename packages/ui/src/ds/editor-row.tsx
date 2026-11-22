import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * One row of an editor (audit P7, design-system.md §5.19): a fixed grid of lead (9rem: a label, a number, a level
 * name), main (the controls) and trailing (2rem: a remove button), tops aligned. The trailing column is always
 * reserved, so a row with a remove button and one without line up and nothing jumps when it appears. Below 768 px
 * the parts stack in one column; an absent trailing part takes no space there.
 */
export function EditorRow({ lead, children, trailing, className }: { lead: ReactNode; children: ReactNode; trailing?: ReactNode; className?: string }) {
  return (
    <div data-slot="editor-row" className={cn("grid grid-cols-1 items-start gap-2 md:grid-cols-[9rem_minmax(0,1fr)_2rem]", className)}>
      {/* on a phone (one column) an empty lead and the trailing wrapper add no row or gap */}
      <div className={cn("min-w-0", lead == null && "max-md:hidden")}>{lead}</div>
      <div className="min-w-0">{children}</div>
      {trailing ? <div className="max-md:contents md:flex md:justify-end">{trailing}</div> : <div aria-hidden="true" className="invisible max-md:hidden" />}
    </div>
  );
}
