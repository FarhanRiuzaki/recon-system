// Where a drag lands on a column of the designer (the mockup's rule): a field dropped on a column's outer third goes
// before or after it, on its middle third replaces what it shows; a column dragged onto another goes before or after.
export type Placement = "before" | "replace" | "after";

export function placement(pointerX: number, rect: { left: number; width: number }, dragged: "field" | "column"): Placement {
  const x = (pointerX - rect.left) / Math.max(1, rect.width);
  if (dragged === "column") return x < 0.5 ? "before" : "after";
  return x < 0.3 ? "before" : x > 0.7 ? "after" : "replace";
}
