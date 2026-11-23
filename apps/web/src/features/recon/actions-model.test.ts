import { describe, expect, it } from "vitest";
import { actionSentence, groupable, mappingGaps, parseTransforms, previewBody, requestLeaves, unfinishedReason } from "./actions-model";

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

describe("why Done is refused (final review I2/I3)", () => {
  const v = { name: "Default", when: null, operation: { connectorId: "c", version: 1, key: "post" }, mapping: {}, per: "item", zeroOrNegative: "skip" };
  const act = (o: object = {}, vo: object = {}) => ({ name: "Post", kind: "posting", on: { event: "approved" }, variants: [{ ...v, ...vo }], ...o }) as never;
  it("a name, each variant's name and operation, its conditions finished", () => {
    expect(unfinishedReason(act())).toBeNull();
    expect(unfinishedReason(act({ name: " " }))).toBe("Name the action first.");
    expect(unfinishedReason(act({}, { operation: { connectorId: "", version: 1, key: "" } }))).toBe("Pick where Default sends to.");
    expect(unfinishedReason(act({}, { when: { all: [{ field: "", op: "eq", value: "" }] } }))).toBe("Finish the conditions of Default.");
  });
  it("every mapped field's source is complete: a template's text, a lookup's table, an account, a field", () => {
    expect(unfinishedReason(act({}, { mapping: { Ref: { kind: "template", text: "" } } }))).toBe("Ref: write its template or remove the mapping.");
    expect(unfinishedReason(act({}, { mapping: { Ref: { kind: "lookup", table: "", key: { kind: "field", key: "break.amount", transforms: [] } } } }))).toBe("Ref: pick its lookup table or remove the mapping.");
    expect(unfinishedReason(act({}, { mapping: { Ref: { kind: "account", account: "", part: "number" } } }))).toBe("Ref: pick its account or remove the mapping.");
    expect(unfinishedReason(act({}, { mapping: { Ref: { kind: "const", value: "" } } }))).toBeNull();
  });
  it("grouped (stage 5): a cutoff needs its time; only a posting on an approval may group", () => {
    const g = (group: object) => ({ per: "group", group: { key: [], at: "cutoff", cutoff: "16:00", ...group } });
    expect(unfinishedReason(act({}, g({})))).toBeNull();
    expect(unfinishedReason(act({}, g({ cutoff: null })))).toBe("Give Default its cutoff time.");
    expect(unfinishedReason(act({ kind: "notify" }, g({})))).toBe("Default sends grouped, which only a posting on an approval does. Send it one per item.");
    expect(unfinishedReason(act({ on: { event: "rejected" } }, g({})))).toBe("Default sends grouped, which only a posting on an approval does. Send it one per item.");
    expect(groupable({ kind: "posting", on: { event: "level_approved", level: 1 } })).toBe(true);
    expect(groupable({ kind: "notify", on: { event: "approved" } })).toBe(false);
  });
});

describe("what the live preview asks (final review m4, m9)", () => {
  const v = { name: "Default", when: null, operation: { connectorId: "c", version: 1, key: "post" }, mapping: {}, per: "item", zeroOrNegative: "skip" };
  const done = { name: "Post", kind: "posting", on: { event: "approved" }, variants: [v] } as never;
  const accounts = [{ key: "suspense", label: "Suspense", number: "1", currency: "IDR" }];
  it("a finished action goes as the draft, with the accounts as edited", () => {
    expect(previewBody("write_off", 0, "b1", done, accounts)).toEqual({ change: "write_off", action: 0, itemId: "b1", draft: done, accounts });
  });
  it("an unfinished one doesn't (the contract would refuse it): the saved action answers, the break's values still come", () => {
    expect(previewBody("write_off", 2, "b1", { ...(done as object), name: "" } as never, accounts)).toEqual({ change: "write_off", action: 2, itemId: "b1", accounts });
  });
});
