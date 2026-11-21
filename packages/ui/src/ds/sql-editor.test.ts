import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { builtInSuggestions, rankSuggestions, SqlEditor, sqlContext, sqlTokens } from "./sql-editor";

describe("sqlTokens", () => {
  it("colours keywords, strings, numbers, comments and :parameters; the pieces join back to the text", () => {
    const sql = "SELECT id, 'it''s' AS note -- why\nFROM t /* x */ WHERE d = :business_date AND n > 10.5 \"Order\"";
    const t = sqlTokens(sql);
    expect(t.map((x) => x.text).join("")).toBe(sql);
    const of = (kind: string) => t.filter((x) => x.kind === kind).map((x) => x.text);
    expect(of("keyword")).toEqual(["SELECT", "AS", "FROM", "WHERE", "AND"]);
    expect(of("string")).toEqual(["'it''s'"]);
    expect(of("comment")).toEqual(["-- why", "/* x */"]);
    expect(of("param")).toEqual([":business_date"]);
    expect(of("number")).toEqual(["10.5"]);
    expect(t.find((x) => x.text === '"Order"')!.kind).toBe("plain");
  });
  it("an unclosed string or comment colours to the end", () => {
    expect(sqlTokens("select 'abc").at(-1)).toEqual({ kind: "string", text: "'abc" });
    expect(sqlTokens("select /* abc").at(-1)).toEqual({ kind: "comment", text: "/* abc" });
  });
});

describe("SqlEditor", () => {
  it("is a textarea over its coloured copy, with the action inside the box", () => {
    const out = renderToStaticMarkup(h(SqlEditor, { id: "q", value: "select 1", onChange: () => {}, action: h("button", { type: "button" }, "Check query") }));
    expect(out).toMatch(/<textarea[^>]*id="q"/);
    expect(out).toContain('<span class="text-code-keyword">select</span>');
    expect(out).toContain('aria-hidden="true"');
    expect(out).toContain("Check query");
  });
});

describe("sqlContext", () => {
  const at = (sql: string) => sqlContext(sql.replace("|", ""), sql.indexOf("|"));
  it("a table after FROM or JOIN, schema-qualified too", () => {
    expect(at("select * from led|")).toMatchObject({ want: "table", word: "led" });
    expect(at("select * from a join core.tx|")).toMatchObject({ want: "table", word: "tx" });
  });
  it("a column of the aliased table after alias.; the query's tables listed", () => {
    expect(at("select l.am| from core.ledger l join fx f on f.id = l.fx")).toMatchObject({ want: "column", table: "core.ledger", word: "am", tables: ["core.ledger", "fx"] });
    expect(at("select ledger.| from core.ledger")).toMatchObject({ want: "column", table: "core.ledger" });
  });
  it("anything elsewhere; nothing inside a string or a comment", () => {
    expect(at("select id, am| from t")).toMatchObject({ want: "any", word: "am" });
    expect(at("select 'am| from t").want).toBe("none");
    expect(at("-- am|").want).toBe("none");
  });
});

describe("suggestions", () => {
  it("keywords and functions where anything goes, params after ':', none where a table is wanted", () => {
    expect(builtInSuggestions(sqlContext("sel", 3), [])).toContainEqual({ label: "SELECT", kind: "keyword" });
    expect(builtInSuggestions(sqlContext("where d = :b", 12), [":business_date"])).toEqual([{ label: ":business_date", kind: "param", detail: "filled in per run" }]);
    expect(builtInSuggestions(sqlContext("from le", 7), [])).toEqual([]);
  });
  it("rank: starts-with first, then contains; the typed word itself and duplicates left out", () => {
    const list = [{ label: "amount", kind: "column" }, { label: "net_amount", kind: "column" }, { label: "AMOUNT", kind: "column" }, { label: "amount", kind: "column" }] as const;
    expect(rankSuggestions(list, "am").map((s) => s.label)).toEqual(["amount", "AMOUNT", "net_amount"]);
    expect(rankSuggestions(list, "amount").map((s) => s.label)).toEqual(["net_amount"]);
  });
});
