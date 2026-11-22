import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@starterkit/ui/ui/tooltip";
import { PageHeader } from "./page-header";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

const html = (more: Parameters<typeof PageHeader>[0]["more"]) => renderToStaticMarkup(h(TooltipProvider, null, h(PageHeader, { title: "Bank API", more })));

describe("PageHeader more actions", () => {
  it("a destructive action that opens its own confirmation (Turn off connector, audit C2) is only in the ⋯ menu, never a header button", () => {
    const out = html([{ label: "Turn on connector", onSelect: () => {} }, { label: "Turn off connector", destructive: true, onSelect: () => {} }]);
    expect(out).toContain(">Turn on connector</button>");
    // the header's buttons are Turn on connector and the ⋯ trigger: Turn off connector is no button of its own
    expect([...out.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => m[1]!.replace(/<[^>]*>/g, ""))).toEqual(["Turn on connector", ""]);
    // the menu trigger shows at every width once a destructive action is in it
    expect(out).toMatch(/<button[^>]*aria-label="More actions"(?![^>]*md:hidden)[^>]*>/);
  });
});
