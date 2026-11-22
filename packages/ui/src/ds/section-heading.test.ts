import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SectionHeading } from "./form-layout";

describe("SectionHeading (a numbered section of a long editor)", () => {
  it("its number in the primary marker, hidden from reading order; the title as a heading; what it is for under it", () => {
    const out = renderToStaticMarkup(h(SectionHeading, { n: 2, title: "What is sent to the bank", description: "Actions that run on approval", level: 3 }));
    expect(out).toMatch(/<span aria-hidden="true" class="[^"]*bg-primary[^"]*text-primary-foreground[^"]*">2<\/span>/);
    expect(out).toMatch(/<h3 class="[^"]*">What is sent to the bank<\/h3>/);
    expect(out).toContain("Actions that run on approval");
  });
  it("without a number it is just the title and description; actions sit on the right", () => {
    const out = renderToStaticMarkup(h(SectionHeading, { title: "Accounts", actions: h("button", null, "Add an account") }));
    expect(out).not.toContain("bg-primary");
    expect(out).toMatch(/<h2/);
    expect(out).toContain("Add an account");
  });
});
