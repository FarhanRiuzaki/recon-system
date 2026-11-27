import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { BRAND } from "@starterkit/shared/brand";
import { LogoMark, LogoWordmark } from ".";

const MARK = ["logo-yellow", "logo-orange", "logo-silver", "logo-grey", "logo-flame"];

/** The logo is the outline SVG of the brand's artwork: an image named BRAND.name, coloured only by the logo tokens. */
describe.each([
  ["mark", LogoMark, "182 0 999 476", MARK],
  ["wordmark", LogoWordmark, "0 0 1363 796", [...MARK, "logo-ink"]],
] as const)("logo %s", (_, Logo, viewBox, fills) => {
  const out = renderToStaticMarkup(h(Logo, { className: "h-9" }));
  it("is one image named by BRAND, sized by className, with the artwork's viewBox", () => {
    expect(out).toMatch(new RegExp(`^<svg [^>]*role="img"[^>]*aria-label="${BRAND.name}"`));
    expect(out).toContain(`viewBox="${viewBox}"`);
    expect(out).toContain('class="h-9"');
  });
  it("each part fills with its --logo-* token, in drawing order; no hex, no text, no stroke", () => {
    expect([...out.matchAll(/<path fill="var\(--([a-z-]+)\)"/g)].map((m) => m[1])).toEqual(fills);
    expect(out).not.toMatch(/#[0-9a-f]{3,6}\b|<text|stroke/i);
  });
});
