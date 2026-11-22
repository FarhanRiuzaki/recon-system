import type { ReactNode } from "react";
import { cn } from "../lib/cn";
import { Icon } from "../ui/icon";
import { ChevronDownIcon } from "../ui/icons";

/**
 * Disclosure (Apple HIG disclosure, APG accordion item): a native <details>, so it opens by mouse, Enter or Space with
 * no script, and the page's find-in-page reaches its content; it opens with the shared block-size transition (base.css,
 * opacity only under reduced motion). The chevron turns when open. Stack several for an accordion; for content a user
 * must see, don't hide it here. `onToggle` hears it open or close (a screen may then mount or clear what is inside).
 */
export function Disclosure({ summary, children, defaultOpen, onToggle, className }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean; onToggle?: (open: boolean) => void; className?: string }) {
  return (
    <details open={defaultOpen} onToggle={onToggle ? (e) => onToggle(e.currentTarget.open) : undefined} className={cn("group rounded-lg border border-line bg-card", className)}>
      <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-3 text-body font-medium text-fg outline-none hover:bg-tray focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-primary [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">{summary}</span>
        <Icon icon={ChevronDownIcon} className="size-4 shrink-0 text-fg-3 transition-transform duration-(--dur-fast) group-open:rotate-180" />
      </summary>
      <div className="px-3 pt-1 pb-3 text-body-sm text-fg-2">{children}</div>
    </details>
  );
}
