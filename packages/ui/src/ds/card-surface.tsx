import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/** Shared tray/card geometry, also usable by error boundaries without interactive panel dependencies. */
export function CardSurface({ children, header, footer, className, bodyClassName, flush, cards }: {
  children: ReactNode; header?: ReactNode; footer?: ReactNode; className?: string; bodyClassName?: string; flush?: boolean; cards?: boolean;
}) {
  return <section className={cn("flex min-w-0 flex-col rounded-xl border border-line bg-tray p-tray", className)}>
    {header}
    {/* cards on the tray: 16 from its edge (tray 4 + 12), the caller's gap-list between them (audit 2 B7) */}
    {cards ? <div className={cn("min-w-0 flex-1 px-3 pb-3", !header && "pt-3", bodyClassName)}>{children}</div> :
      <div className={cn("min-w-0 flex-1 rounded-lg border border-line bg-card", flush ? "overflow-clip" : "p-card", bodyClassName)}>{children}</div>}
    {footer}
  </section>;
}
