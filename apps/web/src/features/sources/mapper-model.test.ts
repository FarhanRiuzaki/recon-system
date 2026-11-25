import { describe, expect, it } from "vitest";
import type { SourceSpec } from "@starterkit/shared/contracts/sources";
import { computeCel } from "@starterkit/shared/compute";
import { addComputed, renameComputed, columnInfo, connect, problemTarget, removeAttr, setFormat, disconnect, renameAttr, rowProblem, setColumn, setJsonPath, setSource, setUnit, sourceGraph, summaryLine, toggleAttr } from "./mapper-model";

const f = (name: string, type: "string" | "decimal" | "date" = "string") => ({ name, type, nullable: true, trim: true });
const spec = (o: Partial<SourceSpec> = {}): SourceSpec => ({
  fields: [f("sid"), f("sre"), f("amt", "decimal"), f("data")],
  mapping: { business_date: { cel: "file_date" }, account_ref: { field: "sid" }, attrs: { sre: { field: "sre" }, amt: { field: "amt" } } },
  derive: { amt2: "amt * 2" }, key_fields: ["sid"], mutable: false, calendar: "id-default",
  input: { kind: "file_inbox", path: "/x", pattern: "*", completion: { kind: "stable_seconds", seconds: 60 }, format: { kind: "delimited", delimiter: "|", quote: '"', header: false, encoding: "utf-8" } },
  ...o,
} as SourceSpec);

describe("sourceGraph", () => {
  it("columns and computed on the left, the core record and folded attributes on the right, a line per column mapping", () => {
    const g = sourceGraph(spec(), { sid: "SID001" });
    expect(g.sources.map((t) => [t.id, t.rows.map((r) => r.key)])).toEqual([["columns", ["sid", "sre", "amt", "data"]], ["computed", ["amt2"]]]);
    expect(g.request.map((r) => r.path)).toEqual(["business_date", "amount_minor", "currency", "direction", "event_time", "ext_ref", "account_ref", "attrs"]);
    expect(g.request.find((r) => r.path === "business_date")).toMatchObject({ mapped: "cel", note: "File name's date" });
    expect(g.request.at(-1)).toMatchObject({ name: "Extra attributes", folded: 2 });
    expect(g.edges).toEqual([{ id: "account_ref", source: "columns", row: "sid", target: "account_ref", label: null }]);
  });

  it("a JSON value of a column draws a dashed line labelled with its path", () => {
    const g = sourceGraph(spec({ mapping: { business_date: { cel: "file_date" }, ext_ref: { cel: computeCel("data", [{ type: "json", args: ["code.rc"] }]) }, attrs: {} } } as Partial<SourceSpec>), {});
    expect(g.edges).toEqual([{ id: "ext_ref", source: "columns", row: "data", target: "ext_ref", label: "code.rc", dashed: true }]);
  });

  it("a mapping to a column the file no longer has is broken, with no line", () => {
    const g = sourceGraph(spec({ fields: [f("sre")] } as Partial<SourceSpec>), {});
    expect(g.request.find((r) => r.path === "account_ref")).toMatchObject({ broken: true, note: "Column sid isn't in the source any more" });
    expect(g.edges).toEqual([]);
  });

  it("200 columns: one row each on the left, still eight rows on the right; a search narrows the left", () => {
    const many = spec({ fields: Array.from({ length: 200 }, (_, i) => f(`c${i}`)), mapping: { business_date: { cel: "file_date" }, attrs: Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`c${i}`, { field: `c${i}` }])) } } as Partial<SourceSpec>);
    const g = sourceGraph(many, {});
    expect([g.sources[0]!.rows.length, g.request.length, g.edges.length]).toEqual([200, 8, 0]);
    expect(sourceGraph(many, {}, { q: "c19" }).sources[0]!.rows.map((r) => r.key)).toEqual(["c19", "c190", "c191", "c192", "c193", "c194", "c195", "c196", "c197", "c198", "c199"]);
  });
});

describe("edits", () => {
  it("connect replaces what fed the row; the amount keeps its unit", () => {
    expect(sourceGraph(connect(spec(), "sre", "account_ref"), {}).edges.map((e) => e.row)).toEqual(["sre"]);
    const withUnit = spec({ mapping: { business_date: { cel: "file_date" }, amount_minor: { field: "amt", unit: "major" }, attrs: {} } } as Partial<SourceSpec>);
    expect(connect(withUnit, "sid", "amount_minor").mapping.amount_minor).toEqual({ field: "sid", unit: "major" });
  });

  it("disconnect empties a core row; the business date is refused", () => {
    expect(disconnect(spec(), "account_ref")).toMatchObject({ mapping: { account_ref: undefined } });
    expect(disconnect(spec(), "business_date")).toEqual({ refused: "The business date is required. Map it to a column or a date preset." });
  });

  it("presets, a formula and one currency for every row", () => {
    expect(setSource(spec(), "business_date", { preset: "arrived_date" }).mapping.business_date).toEqual({ cel: "arrived_date" });
    expect(setSource(spec(), "ext_ref", { cel: "sid + sre" }).mapping.ext_ref).toEqual({ cel: "sid + sre" });
    const c = setSource(spec({ mapping: { business_date: { cel: "file_date" }, currency: { field: "sre" }, attrs: {} } } as Partial<SourceSpec>), "currency", { currency: "IDR" });
    expect([c.currency, c.mapping.currency]).toEqual(["IDR", undefined]);
  });

  it("a column kept as an attribute, or not; the summary counts them", () => {
    expect(toggleAttr(spec(), "sre", false).mapping.attrs).toEqual({ amt: { field: "amt" } });
    expect(toggleAttr(spec(), "data", true, "payload").mapping.attrs.payload).toEqual({ field: "data" });
    expect(summaryLine(spec())).toBe("2 core fields mapped · 2 extra attributes · 1 computed");
  });

  describe("review fixes", () => {
    const g = (s: SourceSpec) => sourceGraph(s, {});
    const row = (s: SourceSpec, k: string) => g(s).request.find((r) => r.path === k)!;
    it("a JSON path whose column is gone is broken, not a formula", () => {
      const s = { ...spec(), mapping: { ...spec().mapping, ext_ref: { cel: computeCel("gone", [{ type: "json", args: ["code.rc"] }]) } } } as SourceSpec;
      expect(row(s, "ext_ref")).toMatchObject({ broken: true, note: "Column gone isn't in the source any more" });
    });
    it("the wizard's empty business date is unmapped and missing", () => {
      const s = { ...spec(), mapping: { ...spec().mapping, business_date: { field: "" } } } as SourceSpec;
      expect(row(s, "business_date").broken).toBeUndefined();
      expect(row(s, "business_date").mapped).toBeNull();
      expect(g(s).missing).toEqual(["business_date"]);
    });
    it("two columns with the same attribute name keep both", () => {
      const s = { ...spec(), fields: [...spec().fields, { name: "Amount", type: "string", nullable: true, trim: true }, { name: "amount", type: "string", nullable: true, trim: true }], mapping: { ...spec().mapping, attrs: {} } } as SourceSpec;
      const both = toggleAttr(toggleAttr(s, "Amount", true), "amount", true);
      expect(Object.values(both.mapping.attrs).map((r) => ("field" in r ? r.field : ""))).toEqual(["Amount", "amount"]);
    });
    it("removing the currency clears the one for every row; an empty one is none", () => {
      const s = setSource(spec(), "currency", { currency: "IDR" });
      const off = disconnect(s, "currency");
      expect("refused" in off ? null : off.currency).toBeUndefined();
      expect(setSource(spec(), "currency", { currency: "" }).currency).toBeUndefined();
    });
  });
});

describe("the rest of the mapper", () => {
  it("a search keeps the columns that feed a line, and marks the kept attributes", () => {
    const g = sourceGraph(spec(), {}, { q: "amt" });
    expect(g.sources[0]!.rows.map((r) => [r.key, r.kind])).toEqual([["sid", "string"], ["amt", "decimal · extra attribute"]]);
  });
  it("the amount's unit, kept when the column changes", () => {
    const s = setUnit(connect(spec(), "amt", "amount_minor"), "minor");
    expect(s.mapping.amount_minor).toEqual({ field: "amt", unit: "minor" });
    expect(rowProblem(connect(spec(), "amt", "amount_minor"), "amount_minor")).toBe("Choose whether the amount is in currency units or minor units.");
    expect(rowProblem(s, "amount_minor")).toBeNull();
  });
  it("a JSON path from a column draws a dashed line", () => {
    const s = setJsonPath(spec(), "ext_ref", "data", "code.rc");
    expect(sourceGraph(s, {}).edges.find((e) => e.id === "ext_ref")).toMatchObject({ row: "data", label: "code.rc", dashed: true });
  });
  it("a row's problem is the one step 2 shows on it", () => {
    const s = { ...spec(), mapping: { ...spec().mapping, account_ref: { field: "gone" } } } as SourceSpec;
    expect(rowProblem(s, "account_ref")).toBe("gone is no longer a column. Pick another column in Use as, or stop using this field.");
    expect(rowProblem(s, "ext_ref")).toBeNull();
  });
  it("a column's type starts with its format; its stored name is checked", () => {
    const s = setColumn(spec(), "sid", { type: "date" });
    expect(s.fields[0]).toMatchObject({ type: "date", format: { date: "yyyy-MM-dd" } });
    expect(setColumn(spec(), "sid", { nullable: false }).fields[0]!.nullable).toBe(false);
    expect(renameAttr(spec(), "sre", "amt")).toEqual({ refused: "Another column is stored as amt. Use a different name." });
    const r = renameAttr(spec(), "sre", "sre_code");
    expect("refused" in r ? null : Object.keys(r.mapping.attrs)).toEqual(["sre_code", "amt"]);
    expect(columnInfo(spec(), "sre")).toEqual({ type: "string", nullable: true, stored: "sre" });
  });
});

describe("review of the inspector", () => {
  it("an amount column that isn't a number is the amount row's problem", () => {
    const s = setColumn(connect(spec(), "amt", "amount_minor"), "amt", { type: "string" });
    expect(rowProblem(setUnit(s, "major"), "amount_minor")).toBe("The amount needs a whole number or a decimal column. Change the type of amt, or pick another column.");
  });
  it("renaming a column that isn't kept is refused; any kept attribute can be removed by name", () => {
    expect(renameAttr(spec(), "sid", "x")).toEqual({ refused: "Keep sid as an extra attribute first." });
    expect(removeAttr(spec(), "amt").mapping.attrs).toEqual({ sre: { field: "sre" } });
  });
});

describe("one place to map", () => {
  it("a new computed column takes the next free name and starts from the first text column", () => {
    const r = addComputed(spec({ derive: { computed_1: "x" } }));
    expect(r.name).toBe("computed_2");
    expect(Object.keys(r.spec.derive)).toEqual(["computed_1", "computed_2"]);
    expect(r.spec.derive.computed_2).toContain("sid");
  });
  it("a column's format: set, and an empty value removed", () => {
    const s = setFormat(spec(), "amt", { scale: 4 });
    expect(s.fields[2]!.format).toEqual({ scale: 4 });
    expect(setFormat(s, "amt", { scale: undefined }).fields[2]!.format).toEqual({});
  });
  it("a step 2 problem opens the mapper where it is", () => {
    expect(problemTarget(spec(), "src-mapping-account_ref")).toBe("account_ref");
    expect(problemTarget(spec(), "src-mapping-amount_minor-unit")).toBe("amount_minor");
    expect(problemTarget(spec(), "src-fields-2-format-scale")).toBe("col:amt");
    expect(problemTarget(spec(), "src-fields-1")).toBe("col:sre");
    expect(problemTarget(spec(), "src-key_fields")).toBeNull();
  });
});

describe("renaming a computed column", () => {
  const s = () => spec({ derive: { amt2: computeCel("amt", []) }, mapping: { business_date: { cel: "file_date" }, account_ref: { field: "amt2" }, ext_ref: { cel: computeCel("amt2", [{ type: "json", args: ["a"] }]) }, attrs: { amt2: { field: "amt2" }, sid: { field: "sid" } } } });
  it("moves every use: core fields, attributes and formulas built on it", () => {
    const r = renameComputed(s(), "amt2", "amt_x");
    if ("refused" in r) throw new Error(r.refused);
    expect(Object.keys(r.derive)).toEqual(["amt_x"]);
    expect(r.mapping.account_ref).toEqual({ field: "amt_x" });
    expect(r.mapping.attrs.amt2).toEqual({ field: "amt_x" });
    expect(r.mapping.ext_ref).toEqual({ cel: computeCel("amt_x", [{ type: "json", args: ["a"] }]) });
  });
  it("refuses an empty name or one a column or computed column has", () => {
    expect(renameComputed(s(), "amt2", " ")).toEqual({ refused: "Give the computed column a name." });
    expect(renameComputed(s(), "amt2", "sid")).toEqual({ refused: "A column is already named sid. Use a different name." });
    expect(renameComputed({ ...s(), derive: { ...s().derive, other: "1" } }, "amt2", "other")).toEqual({ refused: "A column is already named other. Use a different name." });
  });
});
