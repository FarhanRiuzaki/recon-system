import { describe, expect, it } from "vitest";
import type { CatalogField } from "@starterkit/shared/conditions";
import type { OpField } from "@starterkit/shared/integrations";
import type { Source } from "@starterkit/shared/mapping";
import { connect, keepMapping, mapGraph } from "./field-map";

const catalog: CatalogField[] = [
  { key: "break.amount", label: "Amount", group: "break", kind: "number" },
  { key: "break.business_date", label: "Business date", group: "break", kind: "date" },
  { key: "side_a.attrs.ref", label: "BI-FAST switch · settlement · Reference", group: "side_a", kind: "text" },
  { key: "approval.by", label: "Approved by", group: "approval", kind: "text" },
];
const request: OpField[] = [
  { name: "amount", type: "numeric", required: true },
  { name: "Header", type: "object", required: true, children: [{ name: "Ref", type: "string", required: true }, { name: "Channel", type: "string", required: true }] },
  { name: "remark", type: "string", required: false },
  { name: "requestId", type: "string", required: true },
];
const op = { request, fixed: ["Header.Channel"], auto: ["requestId"] };
const accounts = [{ key: "suspense", label: "Suspense", number: "1234", currency: "IDR" }];

describe("the field map as a graph (ERD)", () => {
  const mapping: Record<string, Source> = {
    amount: { kind: "field", key: "break.amount", transforms: ["amount:major:2"] },
    "Header.Ref": { kind: "template", text: "{side_a.attrs.ref}-{accounts.suspense.number}" },
    remark: { kind: "const", value: "Write-off" },
  };
  const g = mapGraph(mapping, catalog, op, accounts);

  it("source tables per group that has fields, the field named first and where it comes from as the table's caption", () => {
    expect(g.sources.map((t) => [t.id, t.title, t.caption, t.rows.map((r) => r.label)])).toEqual([
      ["break", "Unmatch item", null, ["Amount", "Business date"]],
      ["side_a", "Side A", "BI-FAST switch · settlement", ["Reference"]],
      ["approval", "Approval", null, ["Approved by"]],
      ["accounts", "Accounts", null, ["Suspense"]],
    ]);
  });

  it("the request's rows in order, objects as headers, each leaf with what fills it", () => {
    expect(g.request.map((r) => [r.path, r.depth, r.leaf, r.required, r.filledBy, r.mapped])).toEqual([
      ["amount", 0, true, true, null, "field"],
      ["Header", 0, false, true, null, null],
      ["Header.Ref", 1, true, true, null, "template"],
      ["Header.Channel", 1, true, true, "fixed", null],
      ["remark", 0, true, false, null, "const"],
      ["requestId", 0, true, true, "auto", null],
    ]);
    expect(g.missing).toEqual([]);
  });

  it("an edge per field read: a field with its changes as the label, a template's fields and accounts; a fixed value draws none", () => {
    expect(g.edges.map((e) => [e.source, e.row, e.target, e.label])).toEqual([
      ["break", "break.amount", "amount", "amount:major:2"],
      ["side_a", "side_a.attrs.ref", "Header.Ref", "template"],
      ["accounts", "accounts.suspense", "Header.Ref", "template"],
    ]);
  });

  it("names the required fields nothing fills", () => {
    expect(mapGraph({}, catalog, op, accounts).missing).toEqual(["amount", "Header.Ref"]);
  });
});

describe("connecting a row to a request field", () => {
  it("a field becomes a field source, an account an account source", () => {
    expect(connect({}, "break.amount", "amount", op)).toEqual({ amount: { kind: "field", key: "break.amount", transforms: [] } });
    expect(connect({}, "accounts.suspense", "amount", op)).toEqual({ amount: { kind: "account", account: "suspense", part: "number" } });
  });
  it("a second row dropped on a mapped field joins both into a template (owner 22 Nov: gabung beberapa column)", () => {
    const m1 = connect({}, "side_a.attrs.ref", "Header.Ref", op)!;
    const m2 = connect(m1, "break.business_date", "Header.Ref", op)!;
    expect(m2["Header.Ref"]).toEqual({ kind: "template", text: "{side_a.attrs.ref}{break.business_date}" });
    expect(connect(m2, "accounts.suspense", "Header.Ref", op)!["Header.Ref"]).toEqual({ kind: "template", text: "{side_a.attrs.ref}{break.business_date}{accounts.suspense.number}" });
    // a field with changes keeps them inside its braces; a fixed value is replaced, not joined
    const m3 = connect({ amount: { kind: "field", key: "break.amount", transforms: ["abs"] } }, "break.business_date", "amount", op)!;
    expect(m3.amount).toEqual({ kind: "template", text: "{break.amount|abs}{break.business_date}" });
    expect(connect({ remark: { kind: "const", value: "x" } }, "break.amount", "remark", op)!.remark).toEqual({ kind: "field", key: "break.amount", transforms: [] });
  });
  it("keeps the changes when the same field is connected again", () => {
    const m = { amount: { kind: "field" as const, key: "break.amount", transforms: ["abs"] } };
    expect(connect(m, "break.amount", "amount", op)).toBe(m);
  });
  it("refuses a field the operation fills itself, or a header", () => {
    expect(connect({}, "break.amount", "Header.Channel", op)).toBeNull();
    expect(connect({}, "break.amount", "requestId", op)).toBeNull();
    expect(connect({}, "break.amount", "Header", op)).toBeNull();
  });
});

describe("another operation for a variant", () => {
  it("keeps the mappings whose fields it still has and drops the rest", () => {
    const m: Record<string, Source> = { amount: { kind: "const", value: "1" }, gone: { kind: "const", value: "2" }, requestId: { kind: "const", value: "3" } };
    expect(keepMapping(m, op)).toEqual({ amount: { kind: "const", value: "1" } });
  });
});

describe("deferred minors (final review m3, m7)", () => {
  it("a row already in the template isn't appended again", () => {
    const m = { "Header.Ref": { kind: "template" as const, text: "{side_a.attrs.ref}-{break.business_date}" } };
    expect(connect(m, "break.business_date", "Header.Ref", op)).toBe(m);
  });
  it("a field whose changes the template can't hold ({, }, |) is replaced, not joined", () => {
    const m = { amount: { kind: "field" as const, key: "break.amount", transforms: ["default:a|b"] } };
    expect(connect(m, "break.business_date", "amount", op)!.amount).toEqual({ kind: "field", key: "break.business_date", transforms: [] });
  });
  it("a template naming an account the setup doesn't have draws no line to it", () => {
    const g = mapGraph({ "Header.Ref": { kind: "template", text: "{accounts.gone.number}{break.amount}" } }, catalog, op, accounts);
    expect(g.edges.map((e) => e.row)).toEqual(["break.amount"]);
  });
});
