import { describe, expect, it } from "vitest";
import { edgeStyle } from "./graph";

describe("edgeStyle", () => {
  it("draws a JSON-path mapping dashed, every other one as it is", () => {
    expect(edgeStyle({ dashed: true })).toEqual({ strokeDasharray: "4 4" });
    expect(edgeStyle({})).toBeUndefined();
  });
});
