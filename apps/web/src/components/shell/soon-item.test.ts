import { TooltipProvider } from "@starterkit/ui/ui/tooltip";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NAV } from "@/lib/shared/nav";
import { SoonCaption, SoonItem } from "./soon-item";

// two soon items (Breaks, and one more as a later release would add), so the caption names both
const breaks = NAV.find((n) => n.soon)!;
const work = [breaks, { ...breaks, href: "/later", label: "Approvals" }];

describe("SoonItem", () => {
  it("one caption for the group; each item points at it and has no caption or tooltip text of its own", () => {
    const html = renderToStaticMarkup(
      h(TooltipProvider, null, h(SoonCaption, { items: work, id: "cap" }), ...work.map((n) => h(SoonItem, { key: n.href, item: n, captionId: "cap", drawer: true }))),
    );
    expect(html.match(/id="cap"/g)).toHaveLength(1);
    expect(html.match(/aria-describedby="cap"/g)).toHaveLength(work.length);
    expect(html.match(/Breaks and Approvals arrive in a later release\./g)).toHaveLength(1);
    expect(html).not.toContain("Arrives in a later release.");
  });

  it("a group without soon items renders no caption", () => {
    expect(renderToStaticMarkup(h(SoonCaption, { items: NAV.filter((n) => n.group === "access"), id: "x" }))).toBe("");
  });
});
