// The order of a sortable list (sortable-list.tsx) without React or dnd-kit: moving an item, where an index goes when
// another item moves, the keyboard's pick up / move / drop / cancel, and what a screen reader hears. Pure.

/** `items` with the one at `from` moved to `to`; nothing to move (same place, out of range) = the same array. */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) return items as T[];
  const next = [...items];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/** Where index `i` is after the item at `from` moved to `to`: a selected or open row follows its item. */
export function movedIndex(i: number, from: number, to: number): number {
  if (i === from) return to;
  if (from < i && i <= to) return i - 1;
  if (to <= i && i < from) return i + 1;
  return i;
}

/** What a screen reader hears; `name` is the item as numbered before the move, `at` its place now (0-based). */
export const sortText = {
  lifted: (name: string, at: number, count: number) => `${name} picked up, position ${at + 1} of ${count}.`,
  moved: (name: string, at: number, count: number) => `${name} moved to position ${at + 1} of ${count}.`,
  dropped: (name: string, at: number, count: number) => `${name} dropped at position ${at + 1} of ${count}.`,
  cancelled: (name: string, at: number, count: number) => `Move cancelled. ${name} is back at position ${at + 1} of ${count}.`,
};

/** A row picked up by keyboard: where it was picked up, where it is now. */
export type Lift = { from: number; at: number };
export type KeyStep = { lift: Lift | null; move?: readonly [number, number]; say?: string };

const STEP: Record<string, number> = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 };

/**
 * A key on the handle of row `index`: Space or Enter picks the row up and drops it, arrows move it one place, Home and
 * End to an end, Escape puts it back. `move` is the step to apply now; null = not a key of ours (leave its default).
 */
export function sortKey(lift: Lift | null, index: number, key: string, count: number, name: (i: number) => string): KeyStep | null {
  const held = lift && lift.at === index ? lift : null;
  const pick = key === " " || key === "Enter";
  if (!held) return pick ? { lift: { from: index, at: index }, say: sortText.lifted(name(index), index, count) } : null;
  const who = name(held.from);
  if (pick) return { lift: null, say: sortText.dropped(who, held.at, count) };
  if (key === "Escape") return { lift: null, ...(held.at !== held.from ? { move: [held.at, held.from] as const } : {}), say: sortText.cancelled(who, held.from, count) };
  const to = key === "Home" ? 0 : key === "End" ? count - 1 : key in STEP ? Math.min(count - 1, Math.max(0, held.at + STEP[key]!)) : null;
  if (to === null) return null;
  if (to === held.at) return { lift: held };
  return { lift: { from: held.from, at: to }, move: [held.at, to], say: sortText.moved(who, to, count) };
}
