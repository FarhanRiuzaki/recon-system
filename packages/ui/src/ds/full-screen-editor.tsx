"use client";

import type { ReactNode } from "react";
import { Dialog as D } from "radix-ui";
import { cn } from "../lib/cn";
import { ScrollFade } from "./scroll-fade";

/**
 * A full-screen editor (owner 22 Nov: "full screen editor"): a modal dialog over the page with a header (title,
 * description, the actions: View as list, Cancel, Done), a settings rail on the left, the work area in the middle (a
 * canvas), an inspector on the right and a dock under the work area (a preview). Each part is a labelled region with
 * its own scroll (ScrollFade: a fade on each side with content hidden past it) and a clear edge (--line-strong). From 768 px it floats 12 px inside the window on the page's
 * background; below, it fills the screen and the parts stack in one scroll. Escape asks `onOpenChange(false)`: the
 * caller decides (unsaved changes may keep it open). Load it on demand (next/dynamic) with what it holds.
 */
export function FullScreenEditor({ open, onOpenChange, title, description, actions, rail, inspector, dock, dockLabel = "Preview", children }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; actions: ReactNode;
  rail?: ReactNode; inspector?: ReactNode; dock?: ReactNode;
  /** The dock region's name, when it holds more than a preview. */
  dockLabel?: string;
  children: ReactNode;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-scrim data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:duration-(--dur-enter) data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-(--dur-exit)" />
        <D.Content data-slot="full-screen-editor"
          className={cn(
            "fixed inset-0 z-50 flex flex-col overflow-hidden bg-bg text-fg outline-none md:inset-3 md:rounded-xl md:border md:border-line-strong md:shadow-overlay",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-98 data-[state=open]:duration-(--dur-slow) data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:duration-(--dur-exit)",
          )}>
          <header className="flex min-h-16 flex-wrap items-center gap-3 border-b border-line-strong bg-sheet px-5 py-3 max-md:pt-[max(0.75rem,env(safe-area-inset-top))]">
            <span className="grid min-w-0 flex-1">
              <D.Title className="truncate text-title-2 text-fg">{title}</D.Title>
              {description ? <D.Description className="truncate text-body-sm text-fg-3">{description}</D.Description> : <D.Description className="sr-only">{title}</D.Description>}
            </span>
            <span className="flex flex-wrap items-center gap-2">{actions}</span>
          </header>
          <div className={cn("scroll-quiet grid min-h-0 flex-1 max-md:overflow-y-auto",
            rail && inspector ? "md:grid-cols-[18rem_minmax(0,1fr)] xl:grid-cols-[20rem_minmax(0,1fr)_22rem]" : rail ? "md:grid-cols-[18rem_minmax(0,1fr)] xl:grid-cols-[20rem_minmax(0,1fr)]" : inspector ? "xl:grid-cols-[minmax(0,1fr)_22rem]" : "")}>
            {rail && (
              <aside aria-label="Settings" className="min-h-0 border-line-strong bg-sheet max-md:border-b md:border-r"><ScrollFade className="h-full p-5 max-md:overflow-visible">{rail}</ScrollFade></aside>
            )}
            <div className="flex min-h-0 flex-col max-md:min-h-[60dvh]">
              <div className="relative min-h-0 flex-1">{children}</div>
              {dock && <section aria-label={dockLabel} className="shrink-0 border-t border-line-strong bg-sheet"><ScrollFade className="max-h-[36dvh] max-md:max-h-none">{dock}</ScrollFade></section>}
            </div>
            {inspector && (
              <aside aria-label="Inspector" className={cn("min-h-0 border-line-strong bg-sheet max-md:border-t xl:border-l",
                rail && "md:col-span-2 md:border-t xl:col-span-1 xl:border-t-0")}><ScrollFade className="h-full p-5 max-md:overflow-visible">{inspector}</ScrollFade></aside>
            )}
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
