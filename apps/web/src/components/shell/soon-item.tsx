"use client";

import { cn } from "@starterkit/ui/lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@starterkit/ui/ui/tooltip";
import { useId } from "react";
import { type NavItem, SOON_REASON } from "@/lib/shared/nav";
import { NavGlyph } from "./nav-icon";

const SOON_TAG = "shrink-0 rounded-sm border border-line px-1.5 text-caption text-fg-3";

/**
 * A `soon` nav item: a dimmed aria-disabled button (not a link, still in the accessibility tree and the tab order),
 * with the reason as its description and tooltip. `drawer` (phone/touch menu, no hover): 44 px row and the reason
 * shown as a caption. `row` is the sidebar row's classes, `text`: visibility classes of the label and tag (hidden in the 64 px rail, where the tooltip is all there is).
 */
export function SoonItem({ item, drawer, row, text }: { item: NavItem; drawer?: boolean; row?: string; text?: string }) {
  const id = useId();
  const button = (
    <button type="button" aria-disabled="true" aria-label={item.label} aria-describedby={id} onClick={(e) => e.preventDefault()}
      className={cn("flex w-full cursor-default items-center gap-2.5 rounded-md border border-transparent px-2.5 text-start text-fg-3",
        drawer ? "h-11 gap-3 text-body" : row)}>
      <NavGlyph icon={item.icon} className="size-4 shrink-0 opacity-60" />
      <span className={cn("min-w-0 flex-1 truncate opacity-60", text)}>{item.label}</span>
      <span aria-hidden="true" className={cn(SOON_TAG, text)}>Soon</span>
    </button>
  );
  const caption = <span id={id} className="sr-only">{SOON_REASON}</span>;
  if (drawer) return <div className="grid gap-0.5">{button}<span id={id} className="-mt-1 px-2.5 pb-1 pl-9.5 text-caption text-fg-3">{SOON_REASON}</span></div>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right">{SOON_REASON}</TooltipContent>
      {caption}
    </Tooltip>
  );
}
