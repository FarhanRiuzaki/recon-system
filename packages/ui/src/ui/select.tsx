import * as React from "react";
import { cn } from "../lib/cn";

/**
 * Native select styled like Input (32 px, radius 10, control border, card fill; primary focus ring; Down mark when
 * aria-invalid), with its chevron drawn in base.css (12 px in from the edge, text clear of it). For a long list, or one
 * a person searches, use Combobox (ds/combobox).
 */
function Select({ className, ...props }: React.ComponentProps<"select">) {
  return (
    <select
      data-slot="select"
      className={cn(
        // never wider than its container (a native select is as wide as its longest option: owner 26 Nov, Reports Settings)
        "h-8 min-w-0 max-w-full truncate rounded-md border border-control-border bg-card pr-8 pl-2.5 text-body text-fg outline-none",
        "focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-primary-soft aria-invalid:border-down-mark aria-invalid:focus-visible:ring-down-soft disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

export { Select };
