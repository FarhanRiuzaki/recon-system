import { describe, expect, it } from "vitest";
import { ReconSpec } from "@starterkit/shared/contracts/recon";
import { OPERATORS } from "@starterkit/shared/recon";
import { recordFields, type SourceSpecLike } from "@starterkit/shared/recon";
import {
  addCurrency, addCurrencyCondition, addPass, carryOverFix, carryOverGates, isCarryOverWarning, tolerancePass, conditionText, currencyGaps, currencyGapText, defaultSpec, fieldFor, fieldName, fieldReason, type Fields, kindOf,
  movePass, moveReason, pairText, passesText, placeOf, predicateOf, removeCurrency, renameCurrency, splitValues, submitReason, withCardinality, withFilterOp, withSide,
  incompleteField, toleranceProblem,
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

describe("a new pass", () => {
  it("starts with equals on every core field both sides map, candidates by the reference", () => {
    const p = base().passes[0]!;
    expect(p.predicates.map((q) => conditionText(q, fields))).toEqual(["txn_ref equals reference", "ccy equals currency", "amount_minor equals amount", "business_date equals value_date"]);
    expect(p.blocking).toEqual(["ext_ref"]);
    const noRef = recordFields({ ...s2, mapping: { ...s2.mapping, ext_ref: undefined } });
    const q = addPass(defaultSpec({ id: "a", name: "a" }, { id: "b", name: "b" }), [fields[0], noRef]).passes[0]!;
    expect([q.blocking, q.predicates.map((x) => x.field)]).toEqual([[], ["currency", "amount_minor", "business_date"]]);
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
    expect([g.accept, g.on_ambiguous, g.predicates.map((q) => q.op)]).toEqual(["auto", "break", ["eq", "eq", "eq", "eq", "eq_sum"]]);
    expect(withCardinality(g, "1:1", fields).predicates.map((q) => q.op)).toEqual(["eq", "eq", "eq", "eq"]);
  });
});

describe("checks before a save", () => {
  it("the carry-over gate as the spec changes, in the API's words", () => {
    const s = base();
    const windowed = { ...s, carry_over_days: 0, passes: s.passes.map((p, i) => (i === 2 ? { ...p, predicates: [...p.predicates, predicateOf("date_window", "business_date")] } : p)) };
    const gates = carryOverGates(windowed);
    expect(gates).toEqual(["Pass 3 allows dates 1 day apart, but carry over is 0 days: pairs across days never meet in a daily run. Set carry over to 1 day."]);
    expect(isCarryOverWarning(gates[0]!)).toBe(true);
    expect(carryOverFix(gates[0]!)).toBe(1);
    expect(carryOverGates({ ...windowed, carry_over_days: 1 })).toEqual([]);
    expect(carryOverGates({ ...windowed, schedule: { kind: "interval", every_minutes: 15 } })).toEqual([]);
  });

  it("passes comparing amounts without a currency condition, when a side holds more than one currency", () => {
    const s = base();
    const amounts = { ...s, passes: s.passes.map((p) => ({ ...p, predicates: p.predicates.filter((q) => q.field !== "currency") })) };
    expect(currencyGaps(amounts, [s1, s2])).toEqual([1, 2, 3]);
    expect(currencyGapText([1, 2, 3], fields)).toBe("Passes 1–3 compare amounts in more than one currency without a currency condition. Add “ccy equals currency” to each pass.");
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
    expect(tolerancePass("USD has no tolerance in pass 2; USD pairs must match exactly.")).toBe(2);
    expect(tolerancePass("Pass 3 allows dates 1 day apart …")).toBeNull();
  });
  it("Submit says why it is off, in order", () => {
    const v = { simulatedHash: null, matchingHash: "h" };
    const ok = { dirty: false, passes: 2, gaps: [] };
    expect(submitReason(v, { ...ok, dirty: true })).toBe("Wait until the draft is saved.");
    expect(submitReason(v, { ...ok, dirty: true, failed: true })).toBe("The draft isn't saved. Retry the save, then submit.");
    expect(submitReason(v, { ...ok, passes: 0 })).toBe("Add at least one pass, then submit.");
    expect(submitReason(v, { ...ok, gaps: [1, 2, 3] })).toBe("Add a currency condition to passes 1–3 first.");
    expect(submitReason(v, ok)).toBe("Run a simulation on this draft first.");
    expect(submitReason({ simulatedHash: "old", matchingHash: "h" }, ok)).toBe("The draft changed since the last simulation. Run it again.");
    expect(submitReason({ simulatedHash: "h", matchingHash: "h" }, ok)).toBeNull();
  });
});

describe("every spec the builder makes passes the contract", () => {
  const ok = (spec: ReconSpec) => { const r = ReconSpec.safeParse(spec); expect(r.success, JSON.stringify(r.error?.issues)).toBe(true); };
  it("a new recon, added passes, group passes, every operator, the currency fix", () => {
    const empty = defaultSpec({ id: "0b9e3a52-6f1d-4c5e-9a1b-2c3d4e5f6a7b", name: "source1" }, { id: "1c0f4b63-7a2e-4d6f-8b2c-3d4e5f6a7b8c", name: "source2" });
    ok(empty);
    const s = addPass(addPass(empty, fields), fields);
    ok(s);
    for (const c of ["1:N", "N:1"] as const) ok({ ...s, passes: [withCardinality(s.passes[0]!, c, fields), s.passes[1]!] });
    const first = s.passes[0]!;
    for (const op of OPERATORS) {
      const pass = op === "eq_sum" ? withCardinality(first, "N:1", fields) : first;
      ok({ ...s, passes: [{ ...pass, predicates: [...pass.predicates, predicateOf(op, fieldFor(op, first.predicates[0]!.field, fields))] }, s.passes[1]!] });
    }
    ok(addCurrencyCondition(s, [1, 2]));
  });
  it("a group pass has a matching key and one sum (the API's rules), and keeps a key it had", () => {
    const g = withCardinality(base().passes[0]!, "1:N", fields);
    expect(g.blocking).toEqual(["ext_ref"]);
    expect(g.predicates.filter((q) => q.op === "eq_sum")).toHaveLength(1);
    expect(withCardinality({ ...base().passes[0]!, blocking: ["attrs.channel"] }, "N:1", fields).blocking).toEqual(["attrs.channel"]);
  });
  it("an operator's field fits its kind: a text field moves to the amount or the business date; a fitting one stays", () => {
    const kinds = (op: Parameters<typeof fieldFor>[0]) => { const f = fieldFor(op, "ext_ref", fields); return [f, kindOf(f, 0, fields), kindOf(f, 1, fields)]; };
    expect(kinds("amount_abs_tol")).toEqual(["amount_minor", "decimal", "decimal"]);
    expect(kinds("amount_pct_tol")).toEqual(["amount_minor", "decimal", "decimal"]);
    expect(kinds("eq_sum")).toEqual(["amount_minor", "decimal", "decimal"]);
    expect(kinds("date_window")).toEqual(["business_date", "date", "date"]);
    expect(kinds("bday_window")).toEqual(["business_date", "date", "date"]);
    expect(kinds("eq_normalized")).toEqual(["ext_ref", "text", "text"]);
    expect(fieldFor("contains", "amount_minor", fields)).toBe("ext_ref");
    expect(fieldFor("date_window", "business_date", fields)).toBe("business_date");
    expect(fieldFor("eq", "amount_minor", fields)).toBe("amount_minor");
  });
});

describe("tolerance rows and filter values", () => {
  it("a row per currency: add the first one not named, rename in place, remove", () => {
    const t = addCurrency({});
    expect(t).toEqual({ IDR: "" });
    expect(Object.keys(addCurrency({ IDR: "1000.00" }))).toEqual(["IDR", "USD"]);
    expect(Object.entries(renameCurrency({ IDR: "1.00", USD: "2.00" }, "IDR", "JPY"))).toEqual([["JPY", "1.00"], ["USD", "2.00"]]);
    expect(removeCurrency({ IDR: "1.00", USD: "2.00" }, "IDR")).toEqual({ USD: "2.00" });
  });
  it("in / not_in round-trip: comma text without empty entries, the values kept across a switch", () => {
    expect(splitValues("bifast, rtgs,, skn ,")).toEqual(["bifast", "rtgs", "skn"]);
    const inF = withFilterOp({ field: "attrs.channel", op: "eq", value: "bifast" }, "in");
    expect(inF).toEqual({ field: "attrs.channel", op: "in", values: ["bifast"] });
    const many = { field: "attrs.channel", op: "in" as const, values: splitValues("bifast, rtgs") };
    expect(withFilterOp(many, "not_in")).toEqual({ field: "attrs.channel", op: "not_in", values: ["bifast", "rtgs"] });
    expect(withFilterOp(many, "eq")).toEqual({ field: "attrs.channel", op: "eq", value: "bifast" });
    expect(withFilterOp(many, "is_null")).toEqual({ field: "attrs.channel", op: "is_null" });
  });
});

describe("undo of a removal: the removed item goes back into the current spec, edits made meanwhile stay", () => {
  it("remove a condition, edit another pass, Undo: the edit and the condition are both there", async () => {
    const { restoreCondition } = await import("./spec-model");
    const start = base();
    const q = start.passes[0]!.predicates[0]!;
    const removedOne: ReconSpec = { ...start, passes: start.passes.map((p, i) => (i === 0 ? { ...p, predicates: p.predicates.slice(1) } : p)) };
    const edited: ReconSpec = { ...removedOne, passes: removedOne.passes.map((p, i) => (i === 1 ? { ...p, name: "Edited meanwhile" } : p)) };
    const undone = restoreCondition(edited, 0, q, 0)!;
    expect(undone.passes[1]!.name).toBe("Edited meanwhile");
    expect(undone.passes[0]!.predicates).toEqual(start.passes[0]!.predicates);
  });
  it("a row whose pass is gone can't go back; a pass goes back at its index, renumbered, with later edits kept", async () => {
    const { restoreKey, restorePass } = await import("./spec-model");
    const start = base();
    expect(restoreKey(start, 9, start.passes[0]!.blocking[0] ?? { a: "ext_ref", b: "ext_ref" }, 0)).toBeNull();
    const gone = movePass({ ...start, passes: start.passes.slice(1).map((p, i) => ({ ...p, no: i + 1 })) }, 0, 0);
    const edited: ReconSpec = { ...gone, passes: gone.passes.map((p, i) => (i === 0 ? { ...p, name: "Kept" } : p)) };
    const back = restorePass(edited, start.passes[0]!, 0);
    expect(back.passes.map((p) => p.no)).toEqual([1, 2, 3]);
    expect(back.passes[0]!.name).toBe(start.passes[0]!.name);
    expect(back.passes[1]!.name).toBe("Kept");
  });
  it("a tolerance goes back on its condition only when that condition still takes tolerances and lacks the currency", async () => {
    const { restoreTolerance } = await import("./spec-model");
    const tol: ReconSpec = { ...base(), passes: base().passes.map((p, i) => (i === 0 ? { ...p, predicates: [predicateOf("amount_abs_tol", p.predicates[0]!.field)] } : p)) };
    const back = restoreTolerance(tol, 0, 0, "USD", "0.50")!;
    expect((back.passes[0]!.predicates[0] as { tolerance: Record<string, string> }).tolerance.USD).toBe("0.50");
    expect(restoreTolerance(back, 0, 0, "USD", "1.00")).toBeNull();
  });
});

describe("a tolerance row still being filled in (autosave waits; the field says why)", () => {
  const withTol = (tolerance: Record<string, string>) => ({ passes: [{ no: 2, predicates: [{ op: "amount_abs_tol", field: "amount_minor", tolerance }] }] }) as unknown as ReconSpec;
  it("an empty or malformed row keeps the spec from saving and names the row", () => {
    expect(incompleteField(withTol({ IDR: "" }))).toBe("Fill in the IDR tolerance in pass 2.");
    expect(incompleteField(withTol({ IDR: "1,000" }))).toBe("Fill in the IDR tolerance in pass 2.");
    expect(incompleteField(withTol({ IDR: "1000.00" }))).toBeNull();
    expect(incompleteField(withTol({ IDR: "1000.123" }))).toBe("Fill in the IDR tolerance in pass 2.");
    expect(incompleteField(withTol({}))).toBeNull();
  });
  it("the field's own error once left", () => {
    expect(toleranceProblem("", "IDR")).toBe("Enter a tolerance such as 1000.00, or remove the currency.");
    expect(toleranceProblem("abc", "IDR")).toBe("Write the tolerance as a number such as 1000.00");
    expect(toleranceProblem("1000.5", "IDR")).toBeNull();
    // the currency's own decimals, as the API checks them (IDR 2, JPY 0)
    expect(toleranceProblem("1000.123", "IDR")).toBe("IDR takes at most 2 decimals, such as 1000.00.");
    expect(toleranceProblem("1000.12", "IDR")).toBeNull();
    expect(toleranceProblem("1000.5", "JPY")).toBe("JPY takes no decimals, such as 1000.");
  });
});

import { conditionParts, keysText } from "./spec-model";
describe("a pass condition as a reader scans it (owner, 22 Nov: clear, tidy)", () => {
  const side = new Map([["ext_ref", { from: "end_to_end_id", kind: "text" as const }], ["amount_minor", { from: "amount", kind: "decimal" as const }], ["business_date", { from: "value_date", kind: "date" as const }]]);
  const fields = [side, side] as unknown as Parameters<typeof conditionParts>[1];
  it("the field in people's words, the rule in plain words, the source column once when both sides name it", () => {
    expect(conditionParts({ op: "eq", field: "ext_ref" }, fields)).toEqual({ field: "Reference", rule: "the same on both sides", columns: "end_to_end_id" });
    expect(conditionParts({ op: "amount_abs_tol", field: "amount_minor", tolerance: { IDR: "2500.00" } }, fields).rule).toBe("within ± IDR 2,500.00 · other currencies exact");
    expect(conditionParts({ op: "date_window", field: "business_date", days: 1 }, fields)).toMatchObject({ field: "Business date", rule: "within 1 day", columns: "value_date" });
    expect(conditionParts({ op: "eq", field: { a: "ext_ref", b: "attrs.ref2" } }, fields).field).toBe("Reference ↔ ref2");
    expect(keysText(["ext_ref", "business_date"])).toBe("Reference and Business date");
    expect(keysText(["ext_ref"])).toBe("Reference");
  });
});

import { addTemplatePass, passNeeds, templateReason } from "./spec-model";
describe("ready passes and what a pass still needs (owner, 22 Nov)", () => {
  const side = new Map([["ext_ref", { from: "ref", kind: "text" as const }], ["amount_minor", { from: "amount", kind: "decimal" as const }], ["business_date", { from: "d", kind: "date" as const }], ["currency", { from: "ccy", kind: "text" as const }]]);
  const fields = [side, side] as unknown as Parameters<typeof addTemplatePass>[1];
  const base = { sides: [], passes: [], grace_minutes: 30, carry_over_days: 1, close_at: "23:00", schedule: { kind: "daily", at: "06:00", business_date_offset: 1 } } as unknown as Parameters<typeof addTemplatePass>[0];
  it("each template adds its pass, numbered, with the currency condition both sides allow", () => {
    const s = addTemplatePass(addTemplatePass(base, fields, "exact"), fields, "day");
    expect(s.passes.map((p) => [p.no, p.name, p.accept])).toEqual([[1, "Exact match", "auto"], [2, "Settled on another day", "suggest"]]);
    expect(s.passes[0]!.predicates.map((q) => q.op)).toEqual(["eq", "eq", "eq", "eq"]);
    expect(s.passes[1]!.predicates.find((q) => q.op === "date_window")).toMatchObject({ days: 1 });
  });
  it("a fee pass needs its tolerance filled in, and says so on its card; a template refuses a side without its fields", () => {
    const s = addTemplatePass(base, fields, "fee");
    expect(passNeeds(s, 0, [], null)).toEqual([expect.stringMatching(/^Fill in the [A-Z]{3} tolerance$/)]);
    expect(passNeeds(s, 0, [1], "Pass 1: pick a field")).toHaveLength(3);
    expect(templateReason("exact", [side, new Map()] as unknown as typeof fields)).toMatch(/^Both sides need reference, amount, business date/);
    expect(templateReason("blank", [null, null])).toBeNull();
  });
});

import { placeholderName, suggestedConditions, suggestedKey, suggestedName } from "./spec-model";
describe("what the pass editor suggests (owner, 22 Nov: the user knows what to do next)", () => {
  const side = new Map([["ext_ref", { from: "ref", kind: "text" as const }], ["amount_minor", { from: "amount", kind: "decimal" as const }], ["business_date", { from: "d", kind: "date" as const }], ["currency", { from: "ccy", kind: "text" as const }]]);
  const fields = [side, side] as unknown as Parameters<typeof suggestedConditions>[1];
  const pass = (predicates: unknown[], blocking: string[] = []) => ({ no: 1, name: "Pass 1", cardinality: "1:1", blocking, accept: "auto", on_ambiguous: "break", predicates }) as unknown as Parameters<typeof suggestedName>[0];
  it("the fields both sides hold that the conditions don't use yet; the reference to compare by once it must be the same", () => {
    expect(suggestedConditions(pass([{ op: "eq", field: "ext_ref" }]), fields)).toEqual(["currency", "amount_minor", "business_date"]);
    expect(suggestedKey(pass([{ op: "eq", field: "ext_ref" }]), fields)).toBe("ext_ref");
    expect(suggestedKey(pass([{ op: "eq", field: "ext_ref" }], ["ext_ref"]), fields)).toBeNull();
    expect(suggestedKey(pass([{ op: "eq", field: "amount_minor" }]), fields)).toBeNull();
  });
  it("a name from what it checks; currency left out unless alone; only while the name is a placeholder", () => {
    expect(suggestedName(pass([{ op: "eq", field: "ext_ref" }, { op: "eq", field: "amount_minor" }, { op: "eq", field: "currency" }]))).toBe("Same reference and Amount".replace("Amount", "amount"));
    expect(suggestedName(pass([{ op: "amount_abs_tol", field: "amount_minor", tolerance: {} }]))).toBe("Amount within a tolerance");
    expect(suggestedName(pass([{ op: "date_window", field: "business_date", days: 1 }]))).toBe("Business date within 1 day");
    expect([placeholderName("Pass 3"), placeholderName(""), placeholderName("Exact")]).toEqual([true, true, false]);
  });
});

import { SETUP_STEPS, stepReasons } from "./spec-model";
describe("the setup's steps (owner, 22 Nov: Next says what is missing)", () => {
  const ok = { loaded: true, sideProblem: null, passes: 2, needs: [[], []], incomplete: null, settingProblem: null, simulation: "current" as const, running: false, submit: null };
  it("every step can go on when nothing is missing", () => {
    expect(stepReasons(ok)).toEqual({ 1: null, 2: null, 3: null, 4: null, 5: null, 6: null });
    expect(SETUP_STEPS).toEqual({ 1: "Sources", 2: "Matching", 3: "Schedule", 4: "Approval", 5: "Test", 6: "Review and submit" });
  });
  it("each step names what it still needs", () => {
    expect(stepReasons({ ...ok, loaded: false })[1]).toBe("The sides' sources are still loading.");
    expect(stepReasons({ ...ok, passes: 0, needs: [] })[2]).toBe("Add a pass first.");
    expect(stepReasons({ ...ok, needs: [[], ["A name", "A condition"]] })[2]).toBe("Pass 2 needs: a name, a condition.");
    expect(stepReasons({ ...ok, simulation: "none" })[5]).toBe("Run a simulation of this draft first.");
    expect(stepReasons({ ...ok, simulation: "stale" })[5]).toBe("The draft changed since the last simulation. Run it again.");
    expect(stepReasons({ ...ok, running: true })[5]).toBe("Wait for the simulation to finish.");
    expect(stepReasons({ ...ok, submit: "Run a simulation on this draft first." })[6]).toBe("Run a simulation on this draft first.");
  });
});

import { carryText, clockOf, clockProblem, clockWhileTyping } from "./spec-model";

describe("carry over modes (owner, 22 Nov: match / unmatch)", () => {
  it("says each mode in words", () => {
    expect(carryText(0)).toBe("Only on its own day");
    expect(carryText(1)).toBe("Up to day + 1");
    expect(carryText(7)).toBe("Up to day + 7");
    expect(carryText(null)).toBe("Always, until matched or closed");
  });
});

describe("clockOf: a typed time as HH:MM", () => {
  it("takes a colon, a dot or no separator, pads the hour, refuses what isn't a time", () => {
    expect(["23:00", "23.00", "2300", "9:05", " 7.30 ", "00:00"].map(clockOf)).toEqual(["23:00", "23:00", "23:00", "09:05", "07:30", "00:00"]);
    expect(["24:00", "23:60", "", "2", "ab:cd", "123:00"].map(clockOf)).toEqual([null, null, null, null, null, null]);
  });
  it("while typing, three digits wait (230 on the way to 2300 is not 02:30); leaving the field reads them", () => {
    expect(["230", "23", "2", "23:0"].map(clockWhileTyping)).toEqual([null, null, null, null]);
    expect(["2300", "23:00", "9.05"].map(clockWhileTyping)).toEqual(["23:00", "23:00", "09:05"]);
    expect(clockOf("230")).toBe("02:30");
  });
  it("a text that doesn't read as a time is the step's blocking reason, named by its setting", () => {
    expect(clockProblem("Close time", "25:00")).toBe("Close time: Enter a time as HH:MM, such as 23:00.");
    expect(clockProblem("Runs at", "")).toBe("Runs at: Enter a time as HH:MM, such as 23:00.");
    expect(clockProblem("Close time", "230")).toBeNull();
  });
});
