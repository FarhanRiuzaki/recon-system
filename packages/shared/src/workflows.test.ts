import { describe, expect, it } from "vitest";
import { BindingSpec, ChainSpec } from "./contracts/workflows";
import { pickBinding } from "./workflows";

const W1 = "0190f5a0-0000-7000-8000-000000000001";
const W2 = "0190f5a0-0000-7000-8000-000000000002";
const large = { name: "Large", when: [{ attr: "amount" as const, op: "gte" as const, value: "2500000000" }], workflowId: W1 };

describe("pickBinding: approval rules choose a library workflow", () => {
  it("no rules: the default chain", () => {
    expect(pickBinding(null, { amount: "5" })).toEqual({ index: null, ruleName: "Default", workflowId: null });
  });
  it("the first rule that holds gives its workflow", () => {
    expect(pickBinding({ rules: [large], otherwise: W2 }, { amount: "2500000000" })).toEqual({ index: 0, ruleName: "Large", workflowId: W1 });
  });
  it("no rule holds: otherwise, which may be the default", () => {
    expect(pickBinding({ rules: [large], otherwise: W2 }, { amount: "1" })).toEqual({ index: null, ruleName: "Otherwise", workflowId: W2 });
    expect(pickBinding({ rules: [large], otherwise: null }, { amount: "1" }).workflowId).toBeNull();
  });
});

describe("contracts", () => {
  it("rules name workflows by id", () => {
    expect(BindingSpec.safeParse({ rules: [], otherwise: "not-a-uuid" }).success).toBe(false);
    expect(BindingSpec.safeParse({ rules: [large], otherwise: null }).success).toBe(true);
  });
  it("a workflow has a name and at least one level", () => {
    expect(ChainSpec.safeParse({ name: " ", levels: [] }).success).toBe(false);
  });
});
