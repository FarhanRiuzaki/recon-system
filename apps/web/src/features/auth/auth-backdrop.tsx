"use client";

import { useEffect, useRef, useState } from "react";
import { usePrefersReducedMotion } from "@starterkit/ui/motion";
import { cn } from "@starterkit/ui/lib/cn";
import type { FieldColors, LedgerField } from "./ledger-field";

/** Reads the tokens the field is drawn in, for the active theme. */
function tokenColors(): FieldColors {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return { ink: v("--brand-ink"), sun: v("--brand-sun"), match: v("--healthy-mark"), wait: v("--degraded-mark"), dark: document.documentElement.classList.contains("dark") };
}

/**
 * The sign-in pages' backdrop. Server HTML and the first paint show the static halftone landscape; once the page is
 * idle, the Three.js ledger field (`ledger-field.ts`, its own chunk) loads and crossfades in over it. Without WebGL
 * the landscape simply stays. With reduced motion the field draws one still frame. Decoration only (aria-hidden).
 */
export function AuthBackdrop() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const reduced = usePrefersReducedMotion();
  const [live, setLive] = useState(false);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    let field: LedgerField | null = null;
    let cancelled = false;
    const start = () => {
      void import("./ledger-field").then(({ createLedgerField }) => {
        if (cancelled) return;
        try {
          field = createLedgerField(el, { reduced, colors: tokenColors() });
          setLive(true);
        } catch {
          // No WebGL: the static landscape stays.
        }
      }, () => undefined);
    };
    const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    const idle = w.requestIdleCallback ? w.requestIdleCallback(start, { timeout: 1500 }) : window.setTimeout(start, 200);
    // The theme switch flips `.dark` on <html>: recolour in place.
    const themes = new MutationObserver(() => field?.setColors(tokenColors()));
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => {
      cancelled = true;
      if (w.cancelIdleCallback) w.cancelIdleCallback(idle); else window.clearTimeout(idle);
      themes.disconnect();
      field?.dispose();
      setLive(false);
    };
  }, [reduced]);

  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
      <div aria-hidden="true" className={cn("auth-landscape absolute inset-0 transition-opacity duration-(--dur-tween)", live && "opacity-0!")} />
      <canvas key={String(reduced)} ref={canvas} className={cn("absolute inset-0 size-full opacity-0 transition-opacity duration-(--dur-flash)", live && "opacity-100")} />
    </div>
  );
}
