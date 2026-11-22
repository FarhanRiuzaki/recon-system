import { describe, expect, it } from "vitest";
import { grownSince } from "./live-hooks";

describe("grownSince: which sources' records just came in", () => {
  it("those whose count grew, by how much; a lower count (a new day) or a source just listed is not an arrival", () => {
    const before = new Map([["a", 10], ["b", 5], ["c", 7]]);
    expect([...grownSince(before, new Map([["a", 27], ["b", 5], ["c", 0], ["d", 9]]))]).toEqual([["a", 17]]);
  });
});
