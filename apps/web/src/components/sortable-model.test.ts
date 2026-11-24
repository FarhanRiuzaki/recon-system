import { describe, expect, it } from "vitest";
import { movedIndex, moveItem, sortKey, sortText } from "./sortable-model";

describe("moveItem", () => {
  it("moves one item to a new place and keeps the rest in order", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
  });
  it("returns the same array when nothing moves or a place is out of range", () => {
    const xs = ["a", "b"];
    expect(moveItem(xs, 1, 1)).toBe(xs);
    expect(moveItem(xs, 0, 2)).toBe(xs);
    expect(moveItem(xs, -1, 0)).toBe(xs);
  });
});

describe("movedIndex", () => {
  it("follows the moved item, and shifts the ones it passed", () => {
    expect(movedIndex(1, 1, 3)).toBe(3); // the moved one
    expect(movedIndex(2, 1, 3)).toBe(1); // passed going down
    expect(movedIndex(1, 3, 0)).toBe(2); // passed going up
    expect(movedIndex(4, 1, 3)).toBe(4); // outside the move
  });
});

describe("sortText", () => {
  it("says the item by its number before the move and the place out of the count", () => {
    expect(sortText.moved("Column 2", 3, 6)).toBe("Column 2 moved to position 4 of 6.");
    expect(sortText.lifted("Column 2", 1, 6)).toBe("Column 2 picked up, position 2 of 6.");
    expect(sortText.dropped("Column 2", 3, 6)).toBe("Column 2 dropped at position 4 of 6.");
    expect(sortText.cancelled("Column 2", 1, 6)).toBe("Move cancelled. Column 2 is back at position 2 of 6.");
  });
});

describe("sortKey", () => {
  const name = (i: number) => `Column ${i + 1}`;

  it("Space or Enter picks the row up; arrows alone do nothing", () => {
    expect(sortKey(null, 1, " ", 6, name)).toEqual({ lift: { from: 1, at: 1 }, say: "Column 2 picked up, position 2 of 6." });
    expect(sortKey(null, 1, "Enter", 6, name)?.lift).toEqual({ from: 1, at: 1 });
    expect(sortKey(null, 1, "ArrowDown", 6, name)).toBeNull();
    expect(sortKey(null, 1, "Escape", 6, name)).toBeNull();
  });

  it("arrows, Home and End move the lifted row one place or to an end", () => {
    expect(sortKey({ from: 1, at: 1 }, 1, "ArrowDown", 6, name)).toEqual({ lift: { from: 1, at: 2 }, move: [1, 2], say: "Column 2 moved to position 3 of 6." });
    expect(sortKey({ from: 1, at: 2 }, 2, "ArrowUp", 6, name)).toEqual({ lift: { from: 1, at: 1 }, move: [2, 1], say: "Column 2 moved to position 2 of 6." });
    expect(sortKey({ from: 1, at: 2 }, 2, "End", 6, name)?.move).toEqual([2, 5]);
    expect(sortKey({ from: 1, at: 2 }, 2, "Home", 6, name)?.move).toEqual([2, 0]);
  });

  it("an arrow past an end keeps the row and moves nothing", () => {
    expect(sortKey({ from: 0, at: 0 }, 0, "ArrowUp", 6, name)).toEqual({ lift: { from: 0, at: 0 } });
    expect(sortKey({ from: 0, at: 5 }, 5, "ArrowDown", 6, name)).toEqual({ lift: { from: 0, at: 5 } });
  });

  it("Space or Enter drops; Escape puts the row back where it was picked up", () => {
    expect(sortKey({ from: 1, at: 3 }, 3, " ", 6, name)).toEqual({ lift: null, say: "Column 2 dropped at position 4 of 6." });
    expect(sortKey({ from: 1, at: 3 }, 3, "Escape", 6, name)).toEqual({ lift: null, move: [3, 1], say: "Move cancelled. Column 2 is back at position 2 of 6." });
    expect(sortKey({ from: 1, at: 1 }, 1, "Escape", 6, name)).toEqual({ lift: null, say: "Move cancelled. Column 2 is back at position 2 of 6." });
  });

  it("a key on another row's handle starts over from that row", () => {
    expect(sortKey({ from: 1, at: 3 }, 0, " ", 6, name)?.lift).toEqual({ from: 0, at: 0 });
    expect(sortKey({ from: 1, at: 3 }, 0, "ArrowDown", 6, name)).toBeNull();
  });
});
