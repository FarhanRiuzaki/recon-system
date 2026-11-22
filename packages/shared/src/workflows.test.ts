import { describe, expect, it } from "vitest";
import { ChainSpec } from "./contracts/workflows";


describe("contracts", () => {
  it("a workflow has a name and at least one level", () => {
    expect(ChainSpec.safeParse({ name: " ", levels: [] }).success).toBe(false);
  });
});
