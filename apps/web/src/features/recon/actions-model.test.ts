import { describe, expect, it } from "vitest";
import { actionSentence, mappingGaps, parseTransforms, requestLeaves } from "./actions-model";

const op = { request: [{ name: "Amount", type: "numeric" as const, required: true }, { name: "DE48", type: "object" as const, required: true, children: [{ name: "Remark", type: "string" as const, required: true }, { name: "Cur", type: "string" as const, required: true }, { name: "Note", type: "string" as const, required: false }] }], fixed: ["DE48.Cur"], auto: [] as string[] };

describe("the actions editor's helpers", () => {
  it("reads an action as a sentence", () => {
    expect(actionSentence({ name: "Post to GL", kind: "posting", on: { event: "approved" } })).toBe("When the change is approved, post Post to GL");
    expect(actionSentence({ name: "Status", kind: "notify", on: { event: "level_approved", level: 2 } })).toBe("When level 2 approves, send Status");
    expect(actionSentence({ name: "Tell", kind: "notify", on: { event: "rejected" } })).toBe("When the change is rejected, send Tell");
  });
  it("lists the request's leaf fields with what fills them", () => {
    expect(requestLeaves(op)).toEqual([
      { path: "Amount", required: true, filledBy: null }, { path: "DE48.Remark", required: true, filledBy: null },
      { path: "DE48.Cur", required: true, filledBy: "fixed" }, { path: "DE48.Note", required: false, filledBy: null },
    ]);
  });
  it("names the required fields a variant leaves empty", () => {
    expect(mappingGaps({ Amount: { kind: "const", value: "1" } }, op)).toEqual(["DE48.Remark"]);
    expect(mappingGaps({ Amount: { kind: "const", value: "1" }, "DE48.Remark": { kind: "const", value: "x" } }, op)).toEqual([]);
  });
  it("reads typed changes, naming the ones it doesn't know", () => {
    expect(parseTransforms("amount:minor, pad_left:16:0")).toEqual({ list: ["amount:minor", "pad_left:16:0"], bad: [] });
    expect(parseTransforms("upper,  explode ,")).toEqual({ list: ["upper"], bad: ["explode"] });
    expect(parseTransforms("")).toEqual({ list: [], bad: [] });
  });
});
