import { describe, expect, it } from "vitest";
import { groupKeyText } from "./posting";

describe("groupKeyText (stage 5)", () => {
  it("reads a group's key by its labels; an empty value is No <label>; no key is every item", () => {
    expect(groupKeyText([{ label: "Merchant id", value: "0012345" }])).toBe("Merchant id 0012345");
    expect(groupKeyText([{ label: "Merchant id", value: "" }, { label: "Business date", value: "2026-11-23" }])).toBe("No Merchant id · Business date 2026-11-23");
    expect(groupKeyText([])).toBe("All items");
  });
});
