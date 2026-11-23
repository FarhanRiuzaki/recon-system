import { describe, expect, it } from "vitest";
import { ReconApprovalSpec } from "./contracts/recon";
import { groupFields } from "./conditions";
import type { OpField } from "./integrations";
import { applyTransforms, buildGroupPayload, buildPayload, closesAtOf, periodOf, pickVariant, renderTemplate } from "./mapping";

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
    expect(buildPayload({ ...base, mapping: { Ref: { kind: "const", value: "ab" } } } as never, op, ctx, setup, new Set())).toMatchObject({ ok: false, code: "build_error", field: "Note", message: "Note is required, and this item has no value for it." });
    expect(buildPayload({ ...base, mapping: { Ref: { kind: "const", value: "abcdef" }, Note: { kind: "const", value: "x" } } } as never, op, ctx, setup, new Set())).toMatchObject({ ok: false, code: "build_error", field: "Ref", message: "Ref is 6 characters; the bank takes 4. Add a change that keeps the first or the last 4." });
    expect(buildPayload({ ...base, mapping: { Ref: { kind: "lookup", table: "merchants", key: { kind: "const", value: "M9" } }, Note: { kind: "const", value: "x" } } } as never, op, ctx, setup, new Set())).toMatchObject({ ok: false, code: "lookup", field: "Ref", message: "Lookup merchants has no M9." });
    // a field the operation fixes or fills itself needs no mapping
    expect(buildPayload({ ...base, mapping: { Ref: { kind: "const", value: "ab" } } } as never, op, ctx, setup, new Set(["Note"])).ok).toBe(true);
  });
  it("a variant without a condition fits every break", () => {
    expect(pickVariant([{ name: "Every", when: null }], ctx)?.variant.name).toBe("Every");
  });
  it("picks the first variant whose condition holds; none is null", () => {
    const vs = [{ name: "RTGS", when: { all: [{ field: "side_a.attrs.mid", op: "eq", value: "M2" }] } }, { name: "Any", when: { all: [{ field: "break.amount", op: "gte", value: "1" }] } }];
    expect(pickVariant(vs as unknown as { name: string; when: never }[], ctx)?.variant.name).toBe("Any");
    expect(pickVariant(vs.slice(0, 1) as never, ctx)).toBeNull();
  });
});

describe("amount changes refuse a value that isn't whole minor units (final review I1)", () => {
  const op = { request: [{ name: "Fee", type: "numeric", required: true }] } as never;
  const v = (t: string) => ({ name: "V", when: null, zeroOrNegative: "absolute_swap" as const, mapping: { Fee: { kind: "field" as const, key: "side_a.attrs.fee", transforms: [t] } } });
  it("names the field instead of truncating 2500.50 or 1,000.00", () => {
    for (const [value, t] of [["2500.50", "amount:major:2"], ["1,000.00", "amount:major:2"], ["1000.50", "amount:minor"]] as const) {
      const b = buildPayload(v(t), op, { "side_a.attrs.fee": value, "break.amount": "1" }, { accounts: [], lookups: [] }, new Set());
      expect(b).toMatchObject({ ok: false, code: "build_error", field: "Fee" });
    }
  });
  it("still converts whole minor units", () => {
    expect(applyTransforms("250050", ["amount:major:2"], { currency: "IDR" })).toBe("2500.50");
    expect(applyTransforms(" -150 ", ["amount:minor"], {})).toBe("-150");
  });
});

describe("grouped variants (stage 5)", () => {
  it("a grouped variant names its keys and its time; a cutoff needs its HH:MM", () => {
    const g = (group: unknown) => spec([action({ variants: [variant({ per: "group", group })] })]);
    expect(issues(spec([action({ variants: [variant({ per: "group" })] })]))).toContain("Say how the group is formed and when it is sent.");
    expect(issues(g({ key: ["side_a.attrs.merchant_id"], at: "cutoff", cutoff: null }))).toContain("Give the cutoff time, HH:MM.");
    expect(issues(g({ key: ["side_a.attrs.merchant_id"], at: "cutoff", cutoff: "16:00" }))).toEqual([]);
    expect(issues(g({ key: [], at: "day_close", cutoff: null }))).toEqual([]);
    expect(issues(g({ key: Array(6).fill("break.reference"), at: "day_close", cutoff: null }))).toContain("A group has at most 5 key fields.");
    // a group field is a recon field source like any other
    expect(issues(spec([action({ variants: [variant({ per: "group", group: { key: [], at: "day_close", cutoff: null }, mapping: { Amount: { kind: "field", key: "group.sum", transforms: [] } } })] })]))).toEqual([]);
  });

  it("periodOf: the approval's date in Asia/Jakarta, the next day at or after the cutoff", () => {
    expect(periodOf(new Date("2026-11-23T08:59:00Z"), "16:00")).toBe("2026-11-23"); // 15:59 WIB
    expect(periodOf(new Date("2026-11-23T09:00:00Z"), "16:00")).toBe("2026-11-24"); // 16:00 WIB
    expect(periodOf(new Date("2026-11-23T16:30:00Z"), null)).toBe("2026-11-23"); // 23:30 WIB
    expect(periodOf(new Date("2026-11-23T17:00:00Z"), null)).toBe("2026-11-24"); // 00:00 WIB
    expect(periodOf(new Date("2026-11-30T16:30:00Z"), "23:00")).toBe("2026-12-01");
    expect(closesAtOf("2026-11-23", "16:00").toISOString()).toBe("2026-11-23T09:00:00.000Z");
  });

  it("groupFields: the group's own values, its keys by their labels", () => {
    const catalog = [{ key: "side_a.attrs.merchant_id", label: "BI · Merchant id", group: "side_a", kind: "text" }] as const;
    expect(groupFields(["side_a.attrs.merchant_id"], catalog).map((f) => [f.key, f.label, f.kind])).toEqual([
      ["group.sum", "Total amount", "money"], ["group.count", "Number of items", "number"], ["group.period", "Period", "date"],
      ["group.key.side_a.attrs.merchant_id", "Group key: BI · Merchant id", "text"],
    ]);
  });

  const op = { request: [
    { name: "Total", type: "numeric", required: true }, { name: "Count", type: "numeric", required: true }, { name: "Merchant", type: "string", required: true },
    { name: "Items", type: "array", required: true, children: [{ name: "Ref", type: "string", required: true }, { name: "Amount", type: "numeric", required: false }] },
  ] } as { request: OpField[] };
  const members = [
    { "break.amount": "150000", "break.currency": "IDR", "break.reference": "R1", "side_a.attrs.merchant_id": "M1" },
    { "break.amount": "250050", "break.currency": "IDR", "break.reference": "R2", "side_a.attrs.merchant_id": "M1" },
  ];
  const g = { period: "2026-11-23", keys: [{ field: "side_a.attrs.merchant_id", value: "M1" }] };
  const gv = (mapping: object, o: object = {}) => ({ name: "Grouped", when: null, zeroOrNegative: "skip" as const, mapping: mapping as never, ...o });
  const none = { accounts: [], lookups: [] };

  it("buildGroupPayload: sum, count and key from the group, one array element per item", () => {
    const r = buildGroupPayload(gv({
      Total: { kind: "field", key: "group.sum", transforms: ["amount:major:2"] }, Count: { kind: "field", key: "group.count", transforms: [] },
      Merchant: { kind: "template", text: "{group.key.side_a.attrs.merchant_id}-{group.period|date:yyMMdd}" },
      "Items.Ref": { kind: "field", key: "break.reference", transforms: [] }, "Items.Amount": { kind: "field", key: "break.amount", transforms: [] },
    }), op, members, g, none, new Set());
    expect(r).toEqual({ ok: true, payload: { Total: 4000.5, Count: 2, Merchant: "M1-261123", Items: [{ Ref: "R1", Amount: 150000 }, { Ref: "R2", Amount: 250050 }] }, sources: expect.any(Object) });
  });

  it("an item without a required element field fails naming it; a sum of 0 is skipped", () => {
    const m = { Total: { kind: "field", key: "group.sum", transforms: [] }, Count: { kind: "field", key: "group.count", transforms: [] }, Merchant: { kind: "const", value: "x" }, "Items.Ref": { kind: "field", key: "break.reference", transforms: [] } };
    const r = buildGroupPayload(gv(m), op, [members[0]!, { ...members[1]!, "break.reference": "" }], g, none, new Set());
    expect(r).toMatchObject({ ok: false, code: "build_error", field: "Items[2].Ref" });
    const zero = buildGroupPayload(gv(m), op, [{ ...members[0]!, "break.amount": "100" }, { ...members[1]!, "break.amount": "-100" }], g, none, new Set());
    expect(zero).toMatchObject({ ok: false, code: "skipped" });
  });
});
