import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/**
 * An action as a card (audit P9, design-system.md §5.19): what it does (title), what happens when pressed
 * (`consequence`, one sentence), optional `meta` ("Two-level approval · Core banking") and the button, pinned to the
 * bottom so cards in a grid row keep their buttons on one line. `action` is a Button or a BlockedButton with its
 * reason; the card is as tall as its grid row.
 */
export function ActionCard({ title, consequence, meta, action, className }: {
  title: string; consequence: ReactNode; meta?: ReactNode; action: ReactNode; className?: string;
}) {
  return (
    <section data-slot="action-card" className={cn("flex h-full min-w-0 flex-col gap-1.5 rounded-lg border border-line bg-card p-4", className)}>
      <h3 className="text-title-3 text-fg">{title}</h3>
      <p className="text-body-sm text-fg-2">{consequence}</p>
      {meta && <p className="text-caption text-fg-3">{meta}</p>}
      <div className="mt-auto flex pt-3">{action}</div>
    </section>
  );
}
