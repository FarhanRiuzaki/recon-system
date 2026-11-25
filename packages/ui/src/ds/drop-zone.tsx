"use client";

import type { ReactNode, Ref } from "react";
import { cn } from "../lib/cn";

/** A place to drop something (the designer's Group by): a dashed box that turns edit-blue while a drag is over it. */
export function DropZone({ active, label, children, ref, className }: { active: boolean; label: string; children?: ReactNode; ref?: Ref<HTMLDivElement>; className?: string }) {
  return (
    <div ref={ref} data-active={active} aria-label={label} className={cn("flex min-h-10 flex-wrap items-center gap-2 rounded-ctl border-[1.5px] border-dashed px-3 py-2 text-body-sm transition-colors",
      active ? "border-edit-ink bg-edit-soft text-edit-ink" : "border-line-strong text-fg-3", className)}>
      <span className="font-medium">{label}</span>{children}
    </div>
  );
}
