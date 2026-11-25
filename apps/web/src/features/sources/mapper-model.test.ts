import { describe, expect, it } from "vitest";
import type { SourceSpec } from "@starterkit/shared/contracts/sources";
import { computeCel } from "@starterkit/shared/compute";
import { connect, disconnect, setSource, sourceGraph, summaryLine, toggleAttr } from "./mapper-model";

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
    expect(g.request.find((r) => r.path === "account_ref")).toMatchObject({ broken: true, note: "Column sid isn't in the file any more" });
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
});
