import { describe, expect, it } from "vitest";
import { approvalChanges, keptCopy, savable } from "./approval-model";
import { stepReasons } from "./spec-model";

const W = { id: "0190f5a0-0000-7000-8000-00000000000a", version: 1 };
const done = { name: "Large", when: { all: [{ field: "break.amount", op: "gte" as const, value: "1" }] }, workflow: W };
const open = { name: "", when: { all: [{ field: "", op: "eq" as const, value: "" }] }, workflow: { id: "", version: 1 } };

describe("the Approval step's draft", () => {
  it("saves what is finished and keeps only unfinished rules out", () => {
    const r = savable({ changes: { unmatch: { workflow: { default: W, rules: [done, open] } }, write_off: { workflow: { default: null, rules: [] } } } });
    expect(r.unfinished).toBe(true);
    expect(r.approvals).toEqual({ changes: { unmatch: { workflow: { default: W, rules: [done] } } } });
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
    expect(approvalChanges(live, next, true)).toEqual(["unmatch", "write_off"]);
    expect(approvalChanges(live, live, true)).toEqual([]);
    expect(approvalChanges(undefined, next, false)).toEqual([]);
  });
});
