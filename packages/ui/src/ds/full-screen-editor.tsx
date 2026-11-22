"use client";

import type { ReactNode } from "react";
import { Dialog as D } from "radix-ui";
import { cn } from "../lib/cn";

/**
 * A full-screen editor (owner 22 Nov: "full screen editor"): a modal dialog over the page with a header (title,
 * description, the actions: View as list, Cancel, Done), a settings rail on the left, the work area in the middle (a
 * canvas), an inspector on the right and a dock under the work area (a preview). Each part is a labelled region with
 * its own scroll and a clear edge (--line-strong). From 768 px it floats 12 px inside the window on the page's
 * background; below, it fills the screen and the parts stack in one scroll. Escape asks `onOpenChange(false)`: the
 * caller decides (unsaved changes may keep it open). Load it on demand (next/dynamic) with what it holds.
 */
export function FullScreenEditor({ open, onOpenChange, title, description, actions, rail, inspector, dock, children }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: string; description?: string; actions: ReactNode;
  rail?: ReactNode; inspector?: ReactNode; dock?: ReactNode; children: ReactNode;
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
          <header className="flex flex-wrap items-center gap-3 border-b border-line-strong bg-sheet px-5 py-3 pt-safe">
            <span className="grid min-w-0 flex-1">
              <D.Title className="truncate text-title-2 text-fg">{title}</D.Title>
              {description ? <D.Description className="truncate text-body-sm text-fg-3">{description}</D.Description> : <D.Description className="sr-only">{title}</D.Description>}
            </span>
            <span className="flex flex-wrap items-center gap-2">{actions}</span>
          </header>
          <div className={cn("scroll-quiet grid min-h-0 flex-1 max-md:overflow-y-auto",
            rail && inspector ? "md:grid-cols-[18rem_minmax(0,1fr)] xl:grid-cols-[20rem_minmax(0,1fr)_22rem]" : rail ? "md:grid-cols-[18rem_minmax(0,1fr)] xl:grid-cols-[20rem_minmax(0,1fr)]" : inspector ? "xl:grid-cols-[minmax(0,1fr)_22rem]" : "")}>
            {rail && (
              <aside aria-label="Settings" className="scroll-quiet min-h-0 border-line-strong bg-sheet p-5 max-md:border-b md:overflow-y-auto md:border-r">{rail}</aside>
            )}
            <div className="flex min-h-0 flex-col max-md:min-h-[60dvh]">
              <div className="relative min-h-0 flex-1">{children}</div>
              {dock && <section aria-label="Preview" className="scroll-quiet max-h-[40%] shrink-0 overflow-y-auto border-t border-line-strong bg-sheet max-md:max-h-none">{dock}</section>}
            </div>
            {inspector && (
              <aside aria-label="Inspector" className={cn("scroll-quiet min-h-0 border-line-strong bg-sheet p-5 max-md:border-t md:overflow-y-auto xl:border-l",
                rail && "md:col-span-2 md:border-t xl:col-span-1 xl:border-t-0")}>{inspector}</aside>
            )}
          </div>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
