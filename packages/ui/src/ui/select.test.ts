import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Select } from "./select";

describe("Select", () => {
  it("never grows past its container: a native select is as wide as its longest option (owner 26 Nov, Reports Settings)", () => {
    const html = renderToStaticMarkup(h(Select, { "aria-label": "Customer data" }, h("option", null, "Full (space admin, reviewer, config checker download)")));
    for (const c of ["max-w-full", "min-w-0", "truncate"]) expect(html, c).toContain(c);
  });

  it("a caller's width still wins (w-full, md:w-64)", () => {
    expect(renderToStaticMarkup(h(Select, { className: "w-full" }))).toContain("w-full");
  });
});
