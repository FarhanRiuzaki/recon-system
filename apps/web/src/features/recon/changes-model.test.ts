import { describe, expect, it } from "vitest";
import { CHANGE_KINDS, changeOf, changeText, partsOf } from "./changes-model";

describe("changes (transforms) as chips", () => {
  it("builds a change from its kind and values, refusing values the engine wouldn't take", () => {
    expect(changeOf("date", ["yyyyMMdd"])).toBe("date:yyyyMMdd");
    expect(changeOf("amount:major", ["2"])).toBe("amount:major:2");
    expect(changeOf("pad_left", ["16", "0"])).toBe("pad_left:16:0");
    expect(changeOf("upper", [])).toBe("upper");
    expect(changeOf("amount:major", ["9"])).toBeNull();
    expect(changeOf("pad_left", ["16", "00"])).toBeNull();
  });
  it("reads a change back into its kind and values", () => {
    expect(partsOf("pad_left:16:0")).toEqual({ kind: "pad_left", values: ["16", "0"] });
    expect(partsOf("date:dd/MM/yyyy HH:mm")).toEqual({ kind: "date", values: ["dd/MM/yyyy HH:mm"] });
    expect(partsOf("default:-")).toEqual({ kind: "default", values: ["-"] });
    expect(partsOf("trim")).toEqual({ kind: "trim", values: [] });
  });
  it("says each change in words", () => {
    expect(changeText("date:yyyyMMdd")).toBe("Date as yyyyMMdd");
    expect(changeText("amount:major:2")).toBe("Amount with 2 decimals");
    expect(changeText("pad_left:16:0")).toBe("Pad left to 16 with “0”");
    expect(changeText("truncate_right:20")).toBe("Keep the first 20");
  });
  it("offers every kind the engine knows", () => {
    expect(CHANGE_KINDS.map((k) => k.id)).toEqual(["date", "amount:minor", "amount:major", "pad_left", "pad_right", "trim", "upper", "lower", "abs", "truncate_left", "truncate_right", "default"]);
  });
});
