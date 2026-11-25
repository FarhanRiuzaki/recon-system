// Where a drag lands on a column of the designer (the mockup's rule): a field dropped on a column's outer third goes
// before or after it, on its middle third replaces what it shows; a column dragged onto another goes before or after.
export type Placement = "before" | "replace" | "after";

export function placement(pointerX: number, rect: { left: number; width: number }, dragged: "field" | "column"): Placement {
  const x = (pointerX - rect.left) / Math.max(1, rect.width);
  if (dragged === "column") return x < 0.5 ? "before" : "after";
  return x < 0.3 ? "before" : x > 0.7 ? "after" : "replace";
}

/**
 * The keyboard sensor's keys (final review I8): Space picks a header or a field up and Space or Enter drops it; Enter
 * on a column header stays its press (it selects the column), which dnd-kit's default (Enter starts a drag) took.
 */
export const KEYBOARD_CODES = { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] };

/** Where the pointer is at the drop; a keyboard drag has none: its drop goes after the column (insert, never replace). */
export function pointerXOf(ev: Event | null, deltaX: number, rect: { left: number; width: number }): number {
  const x = (ev as PointerEvent | null)?.clientX;
  return typeof x === "number" ? x + deltaX : rect.left + rect.width - 1;
}
