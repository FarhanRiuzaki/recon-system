import { describe, expect, it } from "bun:test";
import type { ReportColumn, ReportSpec } from "@starterkit/shared/contracts/reports";
import { columnFor, emptySpec } from "@starterkit/shared/report-spec";
import { compileFormula } from "../../formula";
import { type DataRow, renderRow, rendererOf } from "../../cells";

const row: DataRow = { date: "2026-11-25", values: { "a:ext_ref": "KS-1", "a:account_ref": "1002345678", "a:amount_minor": 98000000, "b:amount_minor": 97850000, "b:ext_ref": "", "a:attrs.member": "YP", "recon:status": "unmatch" } };
const formula = (id: string, cel: string): ReportColumn => ({ ...columnFor(id, "a:amount_minor", id), content: { kind: "formula", cel } });
const spec = (columns: ReportColumn[], o: Partial<ReportSpec> = {}): ReportSpec => ({ ...emptySpec(), columns, ...o });
const cells = (s: ReportSpec, r = row, i = 0, masked?: boolean) => renderRow(s, r, i, rendererOf(s, new Set(["a:account_ref", "b:account_ref"]), masked));

describe("compileFormula", () => {
  it("compiles CEL over the sides' fields and says which fields it reads", () => {
    const f = compileFormula("a.amount_minor - b.amount_minor");
    expect(f.ok).toBe(true);
    if (f.ok) expect(f.refs.sort()).toEqual(["a:amount_minor", "b:amount_minor"]);
    const at = compileFormula("a.attrs.member + \"-\" + recon.status");
    if (at.ok) expect(at.refs.sort()).toEqual(["a:attrs.member", "recon:status"]);
  });
  it("refuses a broken expression and a function outside the allowlist, with a sentence", () => {
    const bad = compileFormula("a.amount_minor -");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/^Can't parse it/);
    const fn = compileFormula("a.ext_ref.matches(\"x\")");
    if (!fn.ok) expect(fn.error).toBe("The function matches() is not allowed");
    else throw new Error("matches() allowed");
  });
});

describe("renderRow", () => {
  it("a formula's value, formatted by its column; an empty number counts as zero", () => {
    expect(cells(spec([formula("c1", "a.amount_minor - b.amount_minor")])).cells).toEqual(["150.000,00"]);
    const missing = { ...row, values: { ...row.values, "b:amount_minor": null } };
    expect(cells(spec([formula("c1", "a.amount_minor - b.amount_minor")]), missing).cells).toEqual(["98.000.000,00"]);
  });
  it("a formula reading an account is masked like the account (preview and masked files)", () => {
    const s = spec([{ ...formula("c1", "a.account_ref.substring(0, 6)"), format: { kind: "auto" } }]);
    expect(cells(s).cells).toEqual(["··0234"]);
    const full = { ...s, official: true, output: { ...s.output, masking: "full" as const } };
    expect(cells(full).cells).toEqual(["100234"]);
    expect(cells(full, row, 0, true).cells).toEqual(["··0234"]);
  });
  it("accounts masked, fallback when empty, row numbers from 1, fixed text, a field the row lacks is empty", () => {
    const s = spec([
      columnFor("c1", "a:account_ref", "Account"),
      { ...columnFor("c2", "b:ext_ref", "Ref"), content: { kind: "field", ref: "b:ext_ref", fallback: "a:ext_ref" } },
      { ...columnFor("c3", "a:ext_ref", "No"), content: { kind: "rownum" } },
      { ...columnFor("c4", "a:ext_ref", "Ccy"), content: { kind: "text", text: "IDR" } },
      columnFor("c5", "a:attrs.gone", "Gone"),
    ]);
    expect(cells(s, row, 4).cells).toEqual(["······5678", "KS-1", "5", "IDR", ""]);
  });
  it("a formula failing on a row gives #ERR and names the column", () => {
    const r = cells(spec([{ ...formula("c1", "int(a.ext_ref)"), header: "Code" }]));
    expect(r.cells).toEqual(["#ERR"]);
    expect(r.problems).toEqual([{ columnId: "c1", message: expect.stringContaining("Code") }]);
  });
  it("highlight: red when not zero", () => {
    const s = spec([{ ...formula("c1", "a.amount_minor - b.amount_minor"), highlight: { when: "not_zero", style: "red" } }]);
    expect(cells(s).marks).toEqual(["red"]);
  });
});

describe("highlight on masked data", () => {
  it("a masked column gives no highlight (it would tell what the value is); unmasked it does", () => {
    const s = spec([{ ...columnFor("c1", "a:account_ref", "Acct"), format: { kind: "auto" }, highlight: { when: "equals", value: "1002345678", style: "red" } }]);
    expect(cells(s).marks).toEqual([null]);
    expect(cells({ ...s, official: true, output: { ...s.output, masking: "full" } }).marks).toEqual(["red"]);
  });
});
