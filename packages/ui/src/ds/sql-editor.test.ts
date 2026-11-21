import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SqlEditor, sqlTokens } from "./sql-editor";

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
