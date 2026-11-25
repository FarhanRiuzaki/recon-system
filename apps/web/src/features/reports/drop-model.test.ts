import { describe, expect, it } from "vitest";
import { placement } from "./drop-model";

describe("placement", () => {
  const rect = { left: 100, width: 90 };
  it("a field on a column: its outer thirds insert before or after, its middle replaces", () => {
    expect([placement(110, rect, "field"), placement(145, rect, "field"), placement(185, rect, "field")]).toEqual(["before", "replace", "after"]);
  });
  it("a column on a column: its halves move before or after, never replace", () => {
    expect([placement(140, rect, "column"), placement(150, rect, "column")]).toEqual(["before", "after"]);
  });
});
