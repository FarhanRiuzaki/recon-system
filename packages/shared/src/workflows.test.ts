import { describe, expect, it } from "vitest";
import { ChainSpec } from "./contracts/workflows";
import { DEFAULT_CHAIN_TEXT, DEFAULT_LEVELS, defaultChainText } from "./workflows";

describe("the default chain in words", () => {
  it("is one text, built from DEFAULT_LEVELS", () => {
    expect(defaultChainText()).toBe("one of Reviewer or Space admin");
    expect(defaultChainText([{ name: "A", groups: [{ spaceRoles: ["reviewer"], globalRoles: [], users: [], need: { kind: "all" } }] }, ...DEFAULT_LEVELS]))
      .toBe("all of Reviewer, then one of Reviewer or Space admin");
    expect(DEFAULT_CHAIN_TEXT).toBe("Default chain: one of Reviewer or Space admin");
  });
});


describe("contracts", () => {
  it("a workflow has a name and at least one level", () => {
    expect(ChainSpec.safeParse({ name: " ", levels: [] }).success).toBe(false);
  });
});
