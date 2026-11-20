"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/** The open guard's hold on a navigation made in code, or null (one guarded form on screen at a time). */
let holder: ((href: string) => void) | null = null;
/** Sets the hold on navigations made in code; the returned function releases it (if it is still this one). */
export function holdLeaving(fn: (href: string) => void): () => void {
  holder = fn;
  return () => { if (holder === fn) holder = null; };
}
/**
 * A navigation made in code (the page search, the G shortcuts, the space switcher) asks here first: true when a form
 * with unsaved edits holds it (its Leave question opens), false to go ahead.
 */
export function leaveHeld(href: string): boolean {
  if (!holder) return false;
  holder(href);
  return true;
}

/**
 * Unsaved changes: while `dirty`, the browser asks before a reload or closing the tab (beforeunload), and a click on
 * an in-app link, or a navigation made in code through `leaveHeld`, is held: `leaving` is where it pointed, for the
 * screen's ConfirmActionDialog; `leave()` goes there, `stay()` closes the question. Limit: Back/Forward isn't held.
 */
export function useLeaveGuard(dirty: boolean): { leaving: string | null; stay: () => void; leave: () => void; restoreFocus: () => void } {
  const router = useRouter();
  const [leaving, setLeaving] = useState<string | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!dirty) return;
    const unload = (e: BeforeUnloadEvent) => e.preventDefault();
    // Capture phase on the document: runs before Next's Link handler (React listens on the root, below the document).
    const click = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a[href]");
      if (!(a instanceof HTMLAnchorElement) || (a.target && a.target !== "_self") || a.hasAttribute("download")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || (url.pathname === window.location.pathname && url.search === window.location.search)) return;
      e.preventDefault();
      e.stopPropagation();
      opener.current = a;
      setLeaving(url.pathname + url.search + url.hash);
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", click, true);
    const release = holdLeaving((href) => {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setLeaving(href);
    });
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", click, true);
      release();
    };
  }, [dirty]);
  return {
    leaving,
    stay: () => setLeaving(null),
    restoreFocus: () => { if (opener.current?.isConnected) opener.current.focus({ preventScroll: true }); },
    leave: () => { const to = leaving; setLeaving(null); if (to) router.push(to); },
  };
}
