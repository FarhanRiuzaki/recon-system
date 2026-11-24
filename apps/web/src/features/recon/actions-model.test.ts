import { describe, expect, it } from "vitest";
import { actionSentence, changedVariants, groupable, mappingGaps, parseTransforms, previewBody, requestLeaves, unfinishedReason, variantFacts, ZERO_OR_NEGATIVE } from "./actions-model";

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

describe("an action as the checker reads it (ActionSummary)", () => {
  const catalog = [{ key: "break.amount", label: "Amount", group: "break" as const, kind: "money" as const }, { key: "side_a.ext_ref", label: "Core · txn_ref", group: "side_a" as const, kind: "text" as const }];
  const setup = { accounts: [{ key: "susp", label: "Suspense", number: "1001", currency: "IDR" }], lookups: [{ name: "branch" }] };
  const ops = [{ id: "c1", name: "Bank Mega", disabled: false, versions: [{ version: 2, live: true, operations: [{ key: "post", name: "Post GL", method: "POST", path: "/gl", fixed: ["DE48.Cur"], auto: [], masked: ["Account"],
    request: [{ name: "Amount", type: "numeric" as const, required: true }, { name: "Account", type: "string" as const, required: true }, { name: "Ref", type: "string" as const, required: false }, { name: "Branch", type: "string" as const, required: false }] }] }] }];
  const v = { name: "Big", when: { all: [{ field: "break.amount", op: "gte" as const, value: "1000" }] }, operation: { connectorId: "c1", version: 2, key: "post" }, per: "item" as const, zeroOrNegative: "absolute_swap" as const,
    mapping: { Ref: { kind: "template" as const, text: "R-{side_a.ext_ref}" }, Amount: { kind: "field" as const, key: "break.amount", transforms: ["abs"] }, Account: { kind: "account" as const, account: "susp", part: "number" as const },
      Branch: { kind: "lookup" as const, table: "branch", key: { kind: "field" as const, key: "side_a.ext_ref", transforms: [] }, fallback: "000" } } };
  it("says each variant's condition, where it sends, its mapping in words (masked fields marked), how it sends, what 0 or below does", () => {
    expect(variantFacts(v, ops, catalog, setup)).toEqual({
      name: "Big", when: "Amount is at least 1000", sends: "Bank Mega · version 2 · Post GL",
      mapping: [
        { field: "Amount", from: "Amount · Without sign", masked: false }, { field: "Account", from: "Suspense's number", masked: true },
        { field: "Ref", from: "Template “R-{side_a.ext_ref}”", masked: false }, { field: "Branch", from: "Core · txn_ref looked up in branch, else “000”", masked: false },
      ],
      per: "One call per item", zero: "Post it without the sign, sides swapped",
    });
    expect(variantFacts({ ...v, when: null, operation: { connectorId: "gone", version: 1, key: "x" }, mapping: {}, per: "group", zeroOrNegative: "skip", group: { key: ["side_a.ext_ref"], at: "cutoff", cutoff: "16:00" } }, ops, catalog, setup))
      .toEqual(expect.objectContaining({ when: "Every item", sends: "An operation no longer available", per: "Grouped: items with the same Core · txn_ref and currency, sent at 16:00 WIB", zero: "Skip it" }));
  });
  it("words 0 or below as the contract means it", () => {
    expect(ZERO_OR_NEGATIVE.label).toBe("An amount of 0 or below");
    expect(ZERO_OR_NEGATIVE.options).toEqual({ skip: "Skip it", absolute_swap: "Post it without the sign, sides swapped" });
  });
  it("marks the variants that differ from the live version's action of the same name", () => {
    const a = { name: "Post", kind: "posting" as const, on: { event: "approved" as const }, variants: [v, { ...v, name: "Small" }] } as never as Parameters<typeof changedVariants>[1];
    const live = [{ ...(a as object), variants: [{ ...v, zeroOrNegative: "skip" }, { ...v, name: "Small" }] }] as never;
    expect([...changedVariants(live, a, true)]).toEqual([0]);
    expect([...changedVariants([], a, true)]).toEqual([0, 1]); // a new action: every variant is new
    expect([...changedVariants(undefined, a, false)]).toEqual([]);
  });
});
