import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Field } from "./field";

describe("Field help (InfoTip)", () => {
  it("an ⓘ button named for the field sits beside the label, outside it; no help, no button", () => {
    const out = renderToStaticMarkup(h(Field, { id: "wm", label: "Watermark column", help: "How each pull finds what is new.", children: h("input", { id: "wm" }) }));
    expect(out).toContain('aria-label="About Watermark column"');
    expect(out).toMatch(/<\/label><button/);
    expect(renderToStaticMarkup(h(Field, { id: "x", label: "Name", children: h("input", { id: "x" }) }))).not.toContain("About");
  });
});
