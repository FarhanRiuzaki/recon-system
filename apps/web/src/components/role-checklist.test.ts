import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@starterkit/ui/ui/tooltip";
import { ROLE_DESCRIPTION, ROLE_LABEL, SPACE_ROLES, type SpaceRole } from "@starterkit/shared/spaces";
import { RoleChecklist, toggleRole } from "./role-checklist";

const SOURCE_REASON = "Only an app admin can grant or remove Source admin.";
const render = (value: SpaceRole[], canSourceAdmin: boolean, lockedSpaceAdmin = false) =>
  renderToStaticMarkup(h(TooltipProvider, null, h(RoleChecklist, { legend: "Roles in Treasury", value, onChange: () => {}, canSourceAdmin, lockedSpaceAdmin })));
/** The checkbox button of `role` (its aria-label is the role's label). */
const box = (html: string, role: SpaceRole) => new RegExp(`<button[^>]*role="checkbox"[^>]*aria-label="${ROLE_LABEL[role]}"[^>]*>`).exec(html)?.[0] ?? "";

describe("RoleChecklist (Figma 01 Dialog/Change roles)", () => {
  it("seven checkboxes in SPACE_ROLES order, each with its description, the legend and the SoD caption", () => {
    const html = render(["operator"], true);
    expect([...html.matchAll(/role="checkbox"[^>]*aria-label="([^"]+)"/g)].map((m) => m[1])).toEqual(SPACE_ROLES.map((r) => ROLE_LABEL[r]));
    for (const r of SPACE_ROLES) expect(html).toContain(ROLE_DESCRIPTION[r].replace(/'/g, "&#x27;"));
    expect(html).toContain("Roles in Treasury");
    expect(html).toContain("Someone can hold a maker and a checker role together. They still can&#x27;t approve their own requests.");
    expect(box(html, "operator")).toContain('aria-checked="true"');
    expect(box(html, "viewer")).toContain('aria-checked="false"');
  });

  it("without space.manage, Source admin is read-only with its reason, and stays checked when the member holds it", () => {
    const off = render(["source_admin", "viewer"], false);
    expect(box(off, "source_admin")).toContain('aria-readonly="true"');
    expect(box(off, "source_admin")).toContain('aria-checked="true"');
    expect(off).toContain(SOURCE_REASON);
    expect(box(render([], false), "source_admin")).toContain('aria-checked="false"');
    const on = render(["source_admin"], true);
    expect(box(on, "source_admin")).not.toContain("aria-readonly");
    expect(on).not.toContain(SOURCE_REASON);
  });

  it("toggling never changes Source admin without space.manage, nor Space admin while it is locked; the rest toggle in SPACE_ROLES order", () => {
    const opts = { canSourceAdmin: false, lockedSpaceAdmin: false };
    expect(toggleRole(["source_admin", "viewer"], "source_admin", opts)).toEqual(["source_admin", "viewer"]);
    expect(toggleRole(["viewer"], "source_admin", opts)).toEqual(["viewer"]);
    expect(toggleRole(["viewer"], "source_admin", { ...opts, canSourceAdmin: true })).toEqual(["source_admin", "viewer"]);
    expect(toggleRole(["space_admin", "viewer"], "space_admin", { ...opts, lockedSpaceAdmin: true })).toEqual(["space_admin", "viewer"]);
    expect(toggleRole(["space_admin", "viewer"], "space_admin", opts)).toEqual(["viewer"]);
    expect(toggleRole(["viewer"], "operator", opts)).toEqual(["operator", "viewer"]);
  });

  it("the only active space admin: Space admin is checked and read-only, saying why", () => {
    const html = render(["space_admin", "reviewer"], true, true);
    expect(box(html, "space_admin")).toContain('aria-checked="true"');
    expect(box(html, "space_admin")).toContain('aria-readonly="true"');
    expect(html).toContain("A space needs at least one space admin.");
    expect(box(render(["space_admin"], true), "space_admin")).not.toContain("aria-readonly");
  });
});
