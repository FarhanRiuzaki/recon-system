"use client";

// The light parts of the live screens (no React Flow: the recons list, Today, the Overview and New recon import them on
// first load, while the canvases load on demand): a ticking elapsed time, the sources whose records just came in, and a
// source's kind as an icon and a word.
import { useEffect, useRef, useState } from "react";
import { formatDuration } from "@starterkit/ui/lib/format";
import type { IconData } from "@starterkit/ui/ui/icon";
import { DiskIcon, FileIcon } from "@starterkit/ui/ui/icons";

/** How a source's data arrives, as an icon: a database read or a file (the lists and the Space map tell them apart). */
export const sourceKindIcon = (kind: "db_watermark" | "db_snapshot" | "file_inbox"): IconData => (kind === "file_inbox" ? FileIcon : DiskIcon);
export const SOURCE_KIND_WORD: Record<"db_watermark" | "db_snapshot" | "file_inbox", string> = { db_watermark: "Database", db_snapshot: "Database snapshot", file_inbox: "File" };

/** Seconds since `iso`, ticking every second while set ("42 s", "3 min 5 s"); null without one. */
export function useElapsed(iso: string | null | undefined): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!iso) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [iso]);
  return iso ? formatDuration(Math.max(0, Math.round((now - Date.parse(iso)) / 1000))) : null;
}

/** How long a source's new records show as arriving (its sweep, packets and "+N just in") after a read saw them. */
export const ARRIVAL_SHOWN_MS = 8_000;
/** The sources of `now` whose count grew since `before`, by how much (one absent before isn't new: it just appeared). */
export function grownSince(before: ReadonlyMap<string, number>, now: ReadonlyMap<string, number>): Map<string, number> {
  return new Map([...now].flatMap(([id, n]) => (before.has(id) && n > before.get(id)! ? [[id, n - before.get(id)!] as const] : [])));
}

/**
 * Sources whose records for the day grew since the last read of the screen (a poll): their growth, for ARRIVAL_SHOWN_MS.
 * The first read only sets the baseline (nothing arrives on load).
 */
export function useArrivals(sources: readonly { id: string; rowsToday: number | null }[] | undefined): ReadonlyMap<string, number> {
  const seen = useRef<Map<string, number> | null>(null);
  const [arriving, setArriving] = useState<ReadonlyMap<string, number>>(new Map());
  useEffect(() => {
    if (!sources) return;
    const now = new Map(sources.map((s) => [s.id, s.rowsToday ?? 0]));
    const before = seen.current;
    seen.current = now;
    if (!before) return;
    const grown = grownSince(before, now);
    if (!grown.size) return;
    setArriving(grown);
    const t = setTimeout(() => setArriving(new Map()), ARRIVAL_SHOWN_MS);
    return () => clearTimeout(t);
  }, [sources]);
  return arriving;
}
