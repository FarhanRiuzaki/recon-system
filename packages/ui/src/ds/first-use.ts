"use client";

import { useCallback, useSyncExternalStore } from "react";

// Micro-interactions for a new or rarely seen action (design-system §7.9, owner 21 Nov): it shimmers until first used,
// and a section it adds takes the focus. Per browser (localStorage); a blocked storage just never shimmers.

const KEY = (name: string) => `ui:used:${name}`;
const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; };
const read = (name: string) => { try { return localStorage.getItem(KEY(name)) !== null; } catch { return true; } };

/**
 * [fresh, used]: fresh while this browser has never used action `name` (so it shimmers: `text-shimmer`); `used()` marks
 * it. Not fresh on the server and before hydration, so the first paint never animates.
 */
export function useFirstUse(name: string): [boolean, () => void] {
  const used = useSyncExternalStore(subscribe, () => read(name), () => true);
  const mark = useCallback(() => {
    try { localStorage.setItem(KEY(name), "1"); } catch { /* not kept */ }
    listeners.forEach((l) => l());
  }, [name]);
  return [!used, mark];
}

/**
 * Focuses element `id` once it is on the page (a section an action just added renders a frame or two later) and brings
 * it to the middle of the window: smooth, or at once under reduced motion. Gives up after 20 frames.
 */
export function focusNew(id: string, tries = 20): void {
  const el = document.getElementById(id);
  if (!el) { if (tries > 0) requestAnimationFrame(() => focusNew(id, tries - 1)); return; }
  el.focus({ preventScroll: true });
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ block: "center", behavior: reduce ? "auto" : "smooth" });
}
