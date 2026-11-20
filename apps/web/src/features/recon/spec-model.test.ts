import { describe, expect, it } from "vitest";
import type { ReconSpec } from "@starterkit/shared/contracts/recon";
import { recordFields, type SourceSpecLike } from "@starterkit/shared/recon";
import {
  addCurrencyCondition, addPass, carryOverFix, conditionText, currencyGaps, currencyGapText, defaultSpec, fieldName, fieldReason, type Fields, movePass, moveReason,
  pairText, passesText, placeOf, submitReason, withCardinality, withSide,
} from "./spec-model";

// the Plan 3 gate config's sources: source1 (txn_ref, amount_minor, business_date, ccy) and source2 (reference, amount, value_date, currency)
const s1: SourceSpecLike = {
  fields: [{ name: "txn_ref", type: "string" }, { name: "amount_minor", type: "decimal" }, { name: "business_date", type: "date" }, { name: "ccy", type: "string" }, { name: "channel", type: "string" }],
  mapping: { ext_ref: { field: "txn_ref" }, amount_minor: { field: "amount_minor" }, business_date: { field: "business_date" }, currency: { field: "ccy" }, attrs: { channel: { field: "channel" } } },
};
const s2: SourceSpecLike = {
  fields: [{ name: "reference", type: "string" }, { name: "amount", type: "decimal" }, { name: "value_date", type: "date" }, { name: "currency", type: "string" }],
  mapping: { ext_ref: { field: "reference" }, amount_minor: { field: "amount" }, business_date: { field: "value_date" }, currency: { field: "currency" } },
};
const fields: Fields = [recordFields(s1), recordFields(s2)];
const base = (): ReconSpec => addPass(addPass(addPass(defaultSpec({ id: "a", name: "source1" }, { id: "b", name: "source2" }), fields), fields), fields);

describe("fields and conditions in the builder's words", () => {
  it("a side names a field by its source field or stored attribute, never the record column", () => {
    expect(fieldName("ext_ref", fields[0])).toBe("txn_ref");
    expect(fieldName("ext_ref", fields[1])).toBe("reference");
    expect(fieldName("attrs.channel", fields[0])).toBe("channel");
    expect(fieldName("account_ref", null)).toBe("account");
    expect(pairText("ext_ref", fields)).toBe("txn_ref → reference");
    expect(pairText({ a: "attrs.channel", b: "attrs.channel" }, [fields[0], fields[0]])).toBe("channel");
  });
  it("one condition, one line", () => {
    expect(conditionText({ op: "eq", field: "currency" }, fields)).toBe("ccy equals currency");
    expect(conditionText({ op: "amount_abs_tol", field: "amount_minor", tolerance: { IDR: "1000.00" } }, fields)).toBe("amount_minor · amount within ± IDR 1,000.00 · other currencies exact");
    expect(conditionText({ op: "date_window", field: "business_date", days: 1 }, fields)).toBe("business_date · value_date within 1 day");
  });
  it("a per-side pick keeps one name when both sides agree, else { a, b }", () => {
    expect(withSide("ext_ref", 1, "attrs.channel")).toEqual({ a: "ext_ref", b: "attrs.channel" });
    expect(withSide({ a: "ext_ref", b: "attrs.channel" }, 1, "ext_ref")).toBe("ext_ref");
  });
  it("a field of the wrong kind is off with the reason", () => {
    expect(fieldReason("amount_abs_tol", "text", "ext_ref", null)).toBe("Amount is a decimal; this field is text.");
    expect(fieldReason("amount_abs_tol", "decimal", "amount_minor", null)).toBeNull();
    expect(fieldReason("bday_window", "date", "event_time", null)).toBe("Business days are counted on the business date.");
    expect(fieldReason("eq", "text", "ext_ref", "date")).toBe("The other side's field is date; this field is text.");
    expect(fieldReason("key", "decimal", "amount_minor", "decimal")).toBeNull();
  });
});

describe("pass order", () => {
  it("drag and Alt+↑/↓ move a pass; the passes are renumbered in run order", () => {
    const s = base();
    const named = { ...s, passes: s.passes.map((p, i) => ({ ...p, name: ["Exact", "Amount", "Date"][i]! })) };
    const m = movePass(named, 2, 0);
    expect(m.passes.map((p) => [p.no, p.name])).toEqual([[1, "Date"], [2, "Exact"], [3, "Amount"]]);
    expect(movePass(named, 0, 5).passes.map((p) => p.name)).toEqual(["Exact", "Amount", "Date"]);
  });
  it("Move earlier / later say why they are off", () => {
    expect(moveReason(0, 1, 1)).toBe("Only one pass.");
    expect(moveReason(0, 3, -1)).toBe("Already the first pass.");
    expect(moveReason(2, 3, 1)).toBe("Already the last pass.");
    expect(moveReason(1, 3, 1)).toBeNull();
  });
  it("a group pass matches or breaks only and sums its many side; back to 1:1 its sums go", () => {
    const p = { ...base().passes[0]!, accept: "suggest" as const, on_ambiguous: "suggest" as const };
    const g = withCardinality(p, "N:1", fields);
    expect([g.accept, g.on_ambiguous, g.predicates.map((q) => q.op)]).toEqual(["auto", "break", ["eq", "eq_sum"]]);
    expect(withCardinality(g, "1:1", fields).predicates.map((q) => q.op)).toEqual(["eq"]);
  });
});

describe("checks before a save", () => {
  it("passes comparing amounts without a currency condition, when a side holds more than one currency", () => {
    const s = base();
    const amounts = { ...s, passes: s.passes.map((p) => ({ ...p, predicates: [...p.predicates, { op: "eq" as const, field: "amount_minor" }] })) };
    expect(currencyGaps(amounts, [s1, s2])).toEqual([1, 2, 3]);
    expect(currencyGapText([1, 2, 3])).toBe("Passes 1–3 compare amounts in more than one currency without a currency condition. Add “currency equals currency” to each pass.");
    expect(currencyGaps(addCurrencyCondition(amounts, [1, 2, 3]), [s1, s2])).toEqual([]);
    const fixed = (c: string): SourceSpecLike => ({ ...s1, mapping: { ...s1.mapping, currency: undefined }, currency: c });
    expect(currencyGaps(amounts, [fixed("IDR"), fixed("IDR")])).toEqual([]);
    expect(passesText([1, 3, 4])).toBe("passes 1, 3 and 4");
  });
  it("the API's sentence lands where it names", () => {
    expect(placeOf("Pass 2, condition 1, Side A: Amount is decimal; this side's field is text.")).toEqual({ pass: 2, condition: 0, text: "Amount is decimal; this side's field is text." });
    expect(placeOf("Pass 2, condition 1, JPY tolerance: 1 decimal place; JPY allows 0.")).toEqual({ pass: 2, condition: 0, text: "1 decimal place; JPY allows 0." });
    expect(placeOf("Pass 1, matching key 2: x.")).toEqual({ pass: 1, key: 1, text: "x." });
    expect(placeOf("Side B, filter 1: \"x\" is not a number.")).toEqual({ side: 1, filter: 0, text: "\"x\" is not a number." });
    expect(placeOf("Side A: Pick a source of this space or one shared to it.")).toEqual({ side: 0, text: "Pick a source of this space or one shared to it." });
    expect(placeOf("Carry over: Too long.")).toEqual({ setting: "Carry over", text: "Too long." });
    expect(placeOf("Pass 3 compares amounts but has no currency condition.").pass).toBe(3);
    expect(placeOf("Number the passes 1, 2, 3 … in order, with no gaps.")).toEqual({ text: "Number the passes 1, 2, 3 … in order, with no gaps." });
    expect(carryOverFix("Pass 3 allows dates 1 day apart, but carry over is 0 days: pairs across days never meet in a daily run. Set carry over to 1 day.")).toBe(1);
    expect(carryOverFix("USD has no tolerance in pass 2; USD pairs must match exactly.")).toBeNull();
  });
  it("Submit says why it is off, in order", () => {
    const v = { simulatedHash: null, specHash: "h" };
    const ok = { dirty: false, passes: 2, gaps: [] };
    expect(submitReason(v, { ...ok, dirty: true })).toBe("Save the draft, then submit.");
    expect(submitReason(v, { ...ok, passes: 0 })).toBe("Add at least one pass, then submit.");
    expect(submitReason(v, { ...ok, gaps: [1, 2, 3] })).toBe("Add a currency condition to passes 1–3 first.");
    expect(submitReason(v, ok)).toBe("Run a simulation on this draft first.");
    expect(submitReason({ simulatedHash: "old", specHash: "h" }, ok)).toBe("The draft changed since the last simulation. Run it again.");
    expect(submitReason({ simulatedHash: "h", specHash: "h" }, ok)).toBeNull();
  });
});
