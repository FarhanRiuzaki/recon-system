import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Wizard } from "./wizard";

describe("Wizard", () => {
  it("from 1280 px a Panel rail with a line under every marker but the last; below it one line \"Step 2 of 3 · Fields\", no row of connectors (audit 2 B8)", () => {
    const steps = ["Connection", "Fields", "Review"].map((label, i) => ({ id: label, label, status: (i === 0 ? "done" : i === 1 ? "current" : "todo") as "done" | "current" | "todo" }));
    const out = renderToStaticMarkup(h(Wizard, { title: "Setup progress", steps, children: h("form") }));
    expect(out.match(/absolute top-6 bottom-1 left-2\.5 w-px/g)).toHaveLength(2);
    expect(out).not.toContain("h-px w-6");
    expect(out).toMatch(/<h2[^>]*>Setup progress<\/h2>/);
    expect(out).toMatch(/data-slot="wizard-step-line"[^>]*xl:hidden/);
    expect(out.replace(/<[^>]+>/g, "")).toContain("Step 2 of 3 · Fields · In progress");
    expect(out).toContain('aria-current="step"');
  });
});
