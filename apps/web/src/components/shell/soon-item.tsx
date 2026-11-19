"use client";

import { cn } from "@starterkit/ui/lib/cn";
import { Tooltip, TooltipContent, TooltipTrigger } from "@starterkit/ui/ui/tooltip";
import { useState } from "react";
import { type NavItem, SOON_REASON, soonCaption } from "@/lib/shared/nav";
import { NavGlyph } from "./nav-icon";

const SOON_TAG = "shrink-0 rounded-sm border border-line px-1.5 text-caption text-fg-3";

/** The group's one caption under its label (`className`: its layout; the sidebar hides it in the rail). Its `id` is what each `SoonItem` of the group points at. */
export function SoonCaption({ items, id, className }: { items: readonly NavItem[]; id: string; className?: string }) {
  const text = soonCaption(items);
  return text ? <span id={id} className={className}>{text}</span> : null;
}

/**
 * A `soon` nav item: a dimmed aria-disabled button (not a link, still in the accessibility tree and the tab order),
 * described by its group's caption (`captionId`). `drawer` (phone/touch menu): 44 px row. `row` is the sidebar row's
 * classes, `text`: visibility classes of the label and tag. In the 64 px rail (no labels, no caption) a dot marks the
 * icon (`dot`: visibility classes) and the reason is a tooltip: on hover and focus, and on press (a touch screen has
 * no hover; `hideTip` hides it where the caption shows instead).
 */
export function SoonItem({ item, captionId, drawer, row, text, dot, hideTip }: { item: NavItem; captionId: string; drawer?: boolean; row?: string; text?: string; dot?: string; hideTip?: string }) {
  const [open, setOpen] = useState(false);
  const button = (
    <button type="button" aria-disabled="true" aria-label={item.label} aria-describedby={captionId} onClick={(e) => { e.preventDefault(); setOpen(true); }}
      className={cn("flex w-full cursor-default items-center gap-2.5 rounded-md border border-transparent px-2.5 text-start text-fg-3",
        drawer ? "h-11 gap-3 text-body" : row)}>
      <span className="relative shrink-0">
        <NavGlyph icon={item.icon} className="size-4 opacity-60" />
        {!drawer && <span aria-hidden="true" data-slot="soon-dot" className={cn("absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-fg-3", dot)} />}
      </span>
      <span className={cn("min-w-0 flex-1 truncate opacity-60", text)}>{item.label}</span>
      <span aria-hidden="true" className={cn(SOON_TAG, text)}>Soon</span>
    </button>
  );
  if (drawer) return button;
  return (
    <Tooltip open={open} onOpenChange={setOpen}>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right" className={hideTip}>{SOON_REASON}</TooltipContent>
    </Tooltip>
  );
}
