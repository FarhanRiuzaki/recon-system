import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@starterkit/ui/ui/tooltip";
import { SideEditor } from "./inspector";
import { defaultSpec } from "./spec-model";

describe("a side's source in the builder", () => {
  it("is read only and says why: the recon's results are tied to it (the API refuses the change too)", () => {
    const spec = defaultSpec({ id: "a", name: "Core" }, { id: "b", name: "Switching" });
    const html = renderToStaticMarkup(h(TooltipProvider, null, h(SideEditor, { spec, i: 0, fields: [null, null], sourceName: "Core", place: null, onChange: () => {}, onRemoved: () => {} })));
    expect(html).toMatch(/id="rs-0-source"[^>]*readOnly|readOnly[^>]*id="rs-0-source"/i);
    expect(html).toContain("Fixed once the recon exists: its results are tied to this source");
  });
});
