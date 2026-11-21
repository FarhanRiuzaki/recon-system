import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Wizard } from "./wizard";

describe("Wizard", () => {
  it("joins its steps as FormWizard does: a rail line under every marker but the last (xl), a row line before every step but the first", () => {
    const steps = ["Connection", "Fields", "Review"].map((label, i) => ({ id: label, label, status: (i === 0 ? "done" : i === 1 ? "current" : "todo") as "done" | "current" | "todo" }));
    const out = renderToStaticMarkup(h(Wizard, { title: "Setup progress", steps }, h("form")));
    expect(out.match(/absolute top-6 bottom-1 left-2\.5 w-px/g)).toHaveLength(2);
    expect(out.match(/h-px w-6 bg-line-strong xl:hidden/g)).toHaveLength(2);
    expect(out).toContain('aria-current="step"');
  });
});
