import { describe, expect, it } from "vitest";
import { ReconApprovalSpec } from "./contracts/recon";
import { applyTransforms, buildPayload, pickVariant, renderTemplate } from "./mapping";

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

describe("the mapping engine", () => {
  const ctx = {
    "break.amount": "150050", "break.currency": "IDR", "break.business_date": "2026-11-22", "break.reference": " ab12 ",
    "side_a.attrs.e2e_id": "E2E001", "side_a.attrs.mid": "M1", "approval.at": "2026-11-22T03:04:05.000Z",
  };
  const setup = { accounts: [{ key: "suspense", label: "Suspense", number: "1234567890", currency: "IDR" }], lookups: [{ name: "merchants", rows: [{ key: "M1", value: "111" }] }] };
  it("changes a value in order", () => {
    expect(applyTransforms("150050", ["amount:minor"], { currency: "IDR" })).toBe("150050");
    expect(applyTransforms("150050", ["amount:major:2"], { currency: "IDR" })).toBe("1500.50");
    expect(applyTransforms("1500", ["amount:major:0"], { currency: "JPY" })).toBe("1500");
    expect(applyTransforms("1500", ["amount:major:3"], { currency: "KWD" })).toBe("1.500");
    expect(applyTransforms("-12", ["abs", "pad_left:6:0"], {})).toBe("000012");
    expect(applyTransforms(" ab12 ", ["trim", "upper", "pad_right:6:_"], {})).toBe("AB12__");
    expect(applyTransforms("ABCDEFGH", ["truncate_left:3"], {})).toBe("FGH");
    expect(applyTransforms("ABCDEFGH", ["truncate_right:3"], {})).toBe("ABC");
    expect(applyTransforms("", ["default:NA"], {})).toBe("NA");
    expect(applyTransforms("2026-11-22", ["date:yyMMdd"], {})).toBe("261122");
    expect(applyTransforms("2026-11-22T20:00:00.000Z", ["date:yyyy-MM-dd HH:mm"], {})).toBe("2026-11-23 03:00");
  });
  it("renders the owner's remark: e2e id + account number + date", () => {
    expect(renderTemplate("{side_a.attrs.e2e_id}{accounts.suspense.number}{break.business_date|date:yyMMdd}", ctx, setup)).toBe("E2E0011234567890261122");
  });
  it("builds a nested payload; numbers stay numbers; says where each value came from", () => {
    const op = { request: [{ name: "Amount", type: "numeric" as const, required: true }, { name: "DE48", type: "object" as const, required: true, children: [{ name: "Remark", type: "string" as const, required: true, maxLength: 40 }, { name: "Acct", type: "string" as const, required: false }] }] };
    const v = { name: "Default", when: { all: [] }, operation: OP, per: "item" as const, zeroOrNegative: "skip" as const, mapping: {
      Amount: { kind: "field" as const, key: "break.amount", transforms: ["amount:minor"] },
      "DE48.Remark": { kind: "template" as const, text: "{side_a.attrs.e2e_id}-{break.business_date|date:yyMMdd}" },
      "DE48.Acct": { kind: "lookup" as const, table: "merchants", key: { kind: "field" as const, key: "side_a.attrs.mid", transforms: [] } },
    } };
    expect(buildPayload(v as never, op, ctx, setup, new Set())).toEqual({
      ok: true, payload: { Amount: 150050, DE48: { Remark: "E2E001-261122", Acct: "111" } },
      sources: { Amount: "break.amount", "DE48.Remark": "template", "DE48.Acct": "lookup merchants" },
    });
  });
  it("refuses to build with a required field empty, a value too long, or a lookup miss — naming the field", () => {
    const op = { request: [{ name: "Ref", type: "string" as const, required: true, maxLength: 4 }, { name: "Note", type: "string" as const, required: true }] };
    const base = { name: "D", when: { all: [] }, operation: OP, per: "item" as const, zeroOrNegative: "skip" as const };
    expect(buildPayload({ ...base, mapping: { Ref: { kind: "const", value: "ab" } } } as never, op, ctx, setup, new Set())).toMatchObject({ ok: false, code: "build_error", field: "Note", message: "Note is required, and this break has no value for it." });
    expect(buildPayload({ ...base, mapping: { Ref: { kind: "const", value: "abcdef" }, Note: { kind: "const", value: "x" } } } as never, op, ctx, setup, new Set())).toMatchObject({ ok: false, code: "build_error", field: "Ref", message: "Ref is 6 characters; the bank takes 4. Add a change that keeps the first or the last 4." });
    expect(buildPayload({ ...base, mapping: { Ref: { kind: "lookup", table: "merchants", key: { kind: "const", value: "M9" } }, Note: { kind: "const", value: "x" } } } as never, op, ctx, setup, new Set())).toMatchObject({ ok: false, code: "lookup", field: "Ref", message: "Lookup merchants has no M9." });
    // a field the operation fixes or fills itself needs no mapping
    expect(buildPayload({ ...base, mapping: { Ref: { kind: "const", value: "ab" } } } as never, op, ctx, setup, new Set(["Note"])).ok).toBe(true);
  });
  it("picks the first variant whose condition holds; none is null", () => {
    const vs = [{ name: "RTGS", when: { all: [{ field: "side_a.attrs.mid", op: "eq", value: "M2" }] } }, { name: "Any", when: { all: [{ field: "break.amount", op: "gte", value: "1" }] } }];
    expect(pickVariant(vs as unknown as { name: string; when: never }[], ctx)?.variant.name).toBe("Any");
    expect(pickVariant(vs.slice(0, 1) as never, ctx)).toBeNull();
  });
});
