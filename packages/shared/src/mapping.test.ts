import { describe, expect, it } from "vitest";
import { ReconApprovalSpec } from "./contracts/recon";

const OP = { connectorId: "0190f5a0-0000-7000-8000-0000000000c1", version: 1, key: "misc_dc" };
const variant = (o: object = {}) => ({ name: "Default", when: { all: [{ field: "break.amount", op: "gte", value: "1" }] }, operation: OP, mapping: { Amount: { kind: "field", key: "break.amount", transforms: ["amount:minor"] } }, ...o });
const action = (o: object = {}) => ({ name: "Post to GL", kind: "posting", on: { event: "approved" }, variants: [variant()], ...o });
const spec = (actions: unknown[], extra: object = {}) => ({ changes: { unmatch: { workflow: { default: null, rules: [] }, actions } }, ...extra });
const issues = (v: unknown) => ReconApprovalSpec.safeParse(v).error?.issues.map((i) => i.message) ?? [];

describe("approval actions in the recon version (stage 4)", () => {
  it("parses an action with its defaults; a setup from before actions still parses", () => {
    const r = ReconApprovalSpec.parse(spec([action()]));
    expect(r.changes.unmatch!.actions[0]!.variants[0]).toMatchObject({ per: "item", zeroOrNegative: "skip" });
    expect(r.accounts).toEqual([]);
    expect(r.lookups).toEqual([]);
    expect(ReconApprovalSpec.parse({ changes: { unmatch: { workflow: { default: null, rules: [] } } } }).changes.unmatch!.actions).toEqual([]);
  });
  it("events: a level approved names its level; approved and rejected don't", () => {
    expect(issues(spec([action({ on: { event: "level_approved", level: 0 } })]))).not.toEqual([]);
    expect(issues(spec([action({ on: { event: "level_approved", level: 2 } })]))).toEqual([]);
  });
  it("keeps to the limits: 10 actions, 20 variants, 300 mapped fields", () => {
    expect(issues(spec(Array(11).fill(action())))).toContain("A change has at most 10 actions.");
    expect(issues(spec([action({ variants: Array(21).fill(variant()) })]))).toContain("An action has at most 20 variants.");
    const many = Object.fromEntries(Array.from({ length: 301 }, (_, i) => [`F${i}`, { kind: "const", value: "x" }]));
    expect(issues(spec([action({ variants: [variant({ mapping: many })] })]))).toContain("A variant maps at most 300 fields.");
  });
  it("sources: field with transforms, fixed, template, lookup, account; unknown transforms refused", () => {
    const mapping = {
      Amount: { kind: "field", key: "break.amount", transforms: ["amount:minor", "pad_left:16:0"] },
      Currency: { kind: "const", value: "IDR" },
      Remark: { kind: "template", text: "{side_a.attrs.e2e_id}{accounts.suspense.number}{break.business_date|date:yyMMdd}" },
      Account: { kind: "lookup", table: "merchants", key: { kind: "field", key: "side_a.attrs.mid", transforms: [] }, fallback: "0000" },
      Debit: { kind: "account", account: "suspense", part: "number" },
    };
    const extra = { accounts: [{ key: "suspense", label: "Suspense", number: "1234567890", currency: "IDR" }], lookups: [{ name: "merchants", rows: [{ key: "M1", value: "111" }] }] };
    expect(issues(spec([action({ variants: [variant({ mapping })] })], extra))).toEqual([]);
    expect(issues(spec([action({ variants: [variant({ mapping: { A: { kind: "field", key: "break.amount", transforms: ["explode"] } } })] })]))).toContain("Unknown change: explode.");
  });
  it("an account or lookup the setup doesn't have is refused where it is named", () => {
    const mapping = { Debit: { kind: "account", account: "nope", part: "number" }, Remark: { kind: "template", text: "{accounts.gone.number}" }, L: { kind: "lookup", table: "none", key: { kind: "const", value: "k" } } };
    const r = issues(spec([action({ variants: [variant({ mapping })] })]));
    expect(r).toContain("Pick an account of this recon.");
    expect(r).toContain("A template names an account this recon doesn't have: gone.");
    expect(r).toContain("Pick a lookup table of this recon.");
  });
  it("conditions may read approval and request fields", () => {
    expect(issues(spec([action({ variants: [variant({ when: { all: [{ field: "approval.level", op: "eq", value: "2" }, { field: "request.kind", op: "eq", value: "unmatch" }] } })] })]))).toEqual([]);
  });
});
