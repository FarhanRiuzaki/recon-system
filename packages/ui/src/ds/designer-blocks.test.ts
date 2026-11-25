import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DropZone } from "./drop-zone";
import { FieldList, TypeBadge } from "./field-list";
import { FormatExample } from "./format-example";
import { Inspector, InspectorSection } from "./inspector";
import { ToggleChips } from "./toggle-chips";

const groups = [{ label: "Side A · KSEI file", fields: [{ ref: "a:account_ref", label: "Account", type: "text" as const, customer: true }, { ref: "a:amount_minor", label: "Amount", type: "number" as const, customer: false, used: true }] }];

describe("FieldList", () => {
  it("groups under their labels, a type badge, a masked tag on customer data, an add button named for the field, used fields said", () => {
    const out = renderToStaticMarkup(h(FieldList, { groups, query: "", onQuery: () => {}, onAdd: () => {} }));
    expect(out).toContain("Side A · KSEI file");
    expect(out).toContain(">masked<");
    expect(out).toContain('aria-label="Add Account as a column"');
    expect(out).toContain(">123<");
    expect(out).toContain("In the report");
  });
  it("a query keeps the matching fields; none matching says so", () => {
    expect(renderToStaticMarkup(h(FieldList, { groups, query: "amou", onQuery: () => {}, onAdd: () => {} }))).not.toContain(">Account<");
    expect(renderToStaticMarkup(h(FieldList, { groups, query: "zzz", onQuery: () => {}, onAdd: () => {} }))).toContain("No field matches “zzz”.");
  });
  it("TypeBadge per type", () => {
    expect(["text", "number", "date", "status", "formula"].map((t) => renderToStaticMarkup(h(TypeBadge, { type: t as never })).replace(/<[^>]+>/g, ""))).toEqual(["Abc", "123", "Day", "●", "ƒx"]);
  });
});

describe("DropZone, ToggleChips, FormatExample, Inspector", () => {
  it("a drop zone says what to drop and marks when something is over it", () => {
    expect(renderToStaticMarkup(h(DropZone, { active: false, label: "Group by" }, "drag a field here"))).toContain("Group by");
    expect(renderToStaticMarkup(h(DropZone, { active: true, label: "Group by" }))).toContain('data-active="true"');
  });
  it("toggle chips carry aria-pressed per item and a group label", () => {
    const out = renderToStaticMarkup(h(ToggleChips, { label: "In the file", items: [{ key: "title", label: "Title", on: true }, { key: "footer", label: "Footer", on: false }], onToggle: () => {} }));
    expect(out).toContain('aria-label="In the file"');
    expect(out).toMatch(/aria-pressed="true"[^>]*>.*Title/);
    expect(out).toMatch(/aria-pressed="false"[^>]*>.*Footer/);
  });
  it("a format example and an inspector with sections", () => {
    expect(renderToStaticMarkup(h(FormatExample, { items: ["(1.500)", "98.000"] }))).toMatch(/Looks like.*\(1\.500\).*and.*98\.000/);
    const out = renderToStaticMarkup(h(Inspector, { title: "Column", meta: "2 of 6", children: h(InspectorSection, { title: "Format", children: "x" }) }));
    expect(out).toContain("Column");
    expect(out).toContain("2 of 6");
    expect(out).toMatch(/<h3[^>]*>Format<\/h3>/);
  });
});
