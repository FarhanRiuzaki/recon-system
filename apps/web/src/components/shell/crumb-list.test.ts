import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CrumbList } from "./crumb-list";

const render = (labels: string[], sub = true) =>
  renderToStaticMarkup(h(CrumbList, { items: labels.map((label, i) => ({ label, href: i < labels.length - 1 ? `/x${i}` : undefined })), sub, navHref: (x: string) => x }));
/** Each <li> with its data-crumb and the classes of the element that holds its text. */
const items = (html: string) => [...html.matchAll(/<li data-crumb="(\w+)" class="([^"]*)"[^>]*>.*?<(?:a|span)(?: aria-current="page")? (?:href="[^"]*" )?class="([^"]*)"[^>]*>([^<]*)</g)]
  .map((m) => ({ kind: m[1]!, li: m[2]!, text: m[3]!, label: m[4]! }));

describe("CrumbList: the nav page and the open page stay whole, the crumbs between shorten", () => {
  it("first and last whole, middle ones shorten (Recons / Gate recon r2 / Run 21 Nov, 01:40)", () => {
    const got = items(render(["Recons", "Gate recon r2", "Run 21 Nov, 01:40"]));
    expect(got.map((x) => [x.label, x.kind])).toEqual([["Recons", "whole"], ["Gate recon r2", "short"], ["Run 21 Nov, 01:40", "whole"]]);
    // the nav page never shrinks or cuts; the open page doesn't shrink (up to half the bar); a middle crumb cuts with …
    expect(got[0]!.li).toContain("shrink-0");
    expect(got[0]!.text).not.toContain("truncate");
    expect(got[1]!.li).not.toContain("shrink-0");
    expect(got[1]!.text).toContain("truncate");
    expect(got[2]!.li).toContain("shrink-0");
    expect(got[2]!.li).toContain("max-w-1/2");
  });

  it("the open page is plain text with aria-current; the others link back", () => {
    const html = render(["Recons", "Gate recon r2", "Run 21 Nov, 01:40"]);
    expect(html).toContain('aria-current="page"');
    expect(html.match(/<a /g)).toHaveLength(2);
  });

  it("a nav page alone (no sub-page) is the open page and stays whole", () => {
    const got = items(render(["Recons"], false));
    expect(got).toHaveLength(1);
    expect(got[0]!.li).toContain("shrink-0");
    expect(render(["Recons"], false)).toContain('aria-current="page"');
  });
});
