import { describe, expect, it } from "vitest";
import { approvalChanges, approvalRow, approvalWarnings, keptCopy, savable } from "./approval-model";
import { stepReasons } from "./spec-model";

const W = { id: "0190f5a0-0000-7000-8000-00000000000a", version: 1 };
const done = { name: "Large", when: { all: [{ field: "break.amount", op: "gte" as const, value: "1" }] }, workflow: W };
const open = { name: "", when: { all: [{ field: "", op: "eq" as const, value: "" }] }, workflow: { id: "", version: 1 } };

describe("the Approval step's draft", () => {
  it("saves what is finished and keeps only unfinished rules out", () => {
    const r = savable({ changes: { unmatch: { workflow: { default: W, rules: [done, open] } }, write_off: { workflow: { default: null, rules: [] } } } });
    expect(r.unfinished).toBe(true);
    expect(r.approvals).toEqual({ accounts: [], lookups: [], changes: { unmatch: { workflow: { default: W, rules: [done] }, actions: [] } } });
    expect(savable({ changes: { write_off: { workflow: { default: null, rules: [] } } } })).toEqual({ approvals: undefined, unfinished: false });
  });
  it("brings a kept copy back only while the saved draft is still what it was based on", () => {
    const local = { changes: { unmatch: { workflow: { default: W, rules: [done, open] } } } };
    const base = savable(local).approvals;
    expect(keptCopy(JSON.stringify({ base: JSON.stringify(base ?? null), approvals: local }), base)).toEqual(local);
    expect(keptCopy(JSON.stringify({ base: JSON.stringify(base ?? null), approvals: local }), undefined)).toBeNull();
    expect(keptCopy("not json", base)).toBeNull();
    expect(keptCopy(null, base)).toBeNull();
  });
  it("an unfinished rule holds step 4 and the submit", () => {
    const ok = { loaded: true, sideProblem: null, passes: 1, needs: [[]], incomplete: null, settingProblem: null, simulation: "current" as const, running: false, submit: null };
    const why = "A rule is unfinished: name it, complete its conditions and pick its workflow, or remove it.";
    const r = stepReasons({ ...ok, approval: why });
    expect([r[4], r[6]]).toEqual([why, why]);
    expect(stepReasons(ok)[4]).toBeNull();
  });
});

describe("what a version changes in the approval setup", () => {
  it("names the changes whose setup differs from the live version, nothing when there is no live version", () => {
    const live = { changes: { unmatch: { workflow: { default: W, rules: [] } } } };
    const next = { changes: { unmatch: { workflow: { default: W, rules: [done] } }, write_off: { workflow: { default: W, rules: [] } } } };
    expect(approvalChanges(live, next, true)).toEqual(["write_off", "unmatch"]); // in TRIGGERS order: posting first, undo match last
    expect(approvalChanges(live, live, true)).toEqual([]);
    expect(approvalChanges(undefined, next, false)).toEqual([]);
  });
});

describe("the workflow part never drops the rest of the setup (stage 4)", () => {
  it("keeps actions, accounts and lookups, also for a change left on the default chain", () => {
    const action = { name: "Post", kind: "posting" as const, on: { event: "approved" as const }, variants: [] };
    const a = { accounts: [{ key: "susp", label: "Suspense", number: "1", currency: "IDR" }], lookups: [{ name: "m", rows: [] }],
      changes: { unmatch: { workflow: { default: null, rules: [] }, actions: [action] }, write_off: { workflow: { default: null, rules: [] }, actions: [] } } };
    expect(savable(a).approvals).toEqual({ accounts: a.accounts, lookups: a.lookups, changes: { unmatch: { workflow: { default: null, rules: [] }, actions: [action] } } });
    expect(savable({ accounts: [], lookups: [], changes: {} }).approvals).toBeUndefined();
  });
});

describe("the Approval step's table row", () => {
  const names = (id: string) => (id === W.id ? "Two checkers" : null);
  it("says who approves: the default chain, a picked workflow, and how many rules pick another", () => {
    expect(approvalRow(undefined, names)).toEqual({ who: "Default · 1 of Reviewer or Space admin", bank: "Nothing" });
    expect(approvalRow({ workflow: { default: W, rules: [] } }, names).who).toBe("Two checkers");
    expect(approvalRow({ workflow: { default: W, rules: [done, open] } }, names).who).toBe("Two checkers · 2 rules for some cases");
    expect(approvalRow({ workflow: { default: null, rules: [done] } }, names).who).toBe("Default · 1 of Reviewer or Space admin · 1 rule for some cases");
    expect(approvalRow({ workflow: { default: { id: "gone", version: 1 }, rules: [] } }, names).who).toBe("A workflow no longer available");
  });
  it("says what is sent to the bank: the actions by name, or Nothing", () => {
    const post = { name: "Post to GL", kind: "posting" as const, on: { event: "approved" as const }, variants: [] };
    expect(approvalRow({ workflow: { default: null, rules: [] }, actions: [post, { ...post, name: " " }] }, names).bank).toBe("Post to GL, An action without a name");
  });
});

describe("approvalWarnings (audit 2: step 2 showed one amber notice per approval action field)", () => {
  it("splits the draft's warnings into the approval actions' (\"<change> · <action> · <variant>: …\") and the rest", () => {
    const ws = [
      "Undo match · k · Default: fromDateTime is required. Map it, or give it a fixed or auto value.",
      "Write-off · Post to GL · Default: the connector picked no longer exists. Pick another one.",
      "Pass 2 uses Amount, which side B doesn't have.",
    ];
    expect(approvalWarnings(ws)).toEqual({ approval: ws.slice(0, 2), other: [ws[2]] });
    expect(approvalWarnings([])).toEqual({ approval: [], other: [] });
  });
});
