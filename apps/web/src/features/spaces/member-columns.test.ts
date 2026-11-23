import { createElement as h, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@starterkit/ui/ui/tooltip";
import type { SpaceMemberDto } from "@starterkit/shared/contracts/spaces";
import { MEMBER_COLUMNS } from "./member-columns";

const M: SpaceMemberDto = { userId: "u1", name: "Rina Hapsari", username: "rina.h", roles: ["config_checker", "reviewer"], active: true, lastSignInAt: null };
const cell = (key: string, m: SpaceMemberDto = M) =>
  renderToStaticMarkup(h(TooltipProvider, null, h(Fragment, null, MEMBER_COLUMNS.find((c) => c.key === key)!.cell(m))));

describe("members table columns (audit §5.6: Member · Roles in this space · Status · Last sign-in · hidden Username)", () => {
  it("in that order, the member is the phone card's title, the username hidden until chosen and off the card", () => {
    expect(MEMBER_COLUMNS.map((c) => c.header)).toEqual(["Member", "Roles in this space", "Status", "Last sign-in", "Username"]);
    expect(MEMBER_COLUMNS.map((c) => c.mobile ?? "meta")).toEqual(["title", "meta", "meta", "meta", "hidden"]);
    expect(MEMBER_COLUMNS.filter((c) => c.defaultHidden).map((c) => c.key)).toEqual(["username"]);
  });
  it("a tablet (768–1279) hides Last sign-in; the phone card keeps it", () => {
    const tablet = (key: string) => MEMBER_COLUMNS.find((c) => c.key === key)!.className ?? "";
    expect(tablet("lastSignInAt")).toMatch(/\bmd:max-xl:hidden\b/);
    for (const k of ["name", "roles", "status"]) expect(tablet(k)).not.toMatch(/hidden/);
  });
  it("one chip per role, labelled; Active / Inactive; the username in mono; Never when never signed in", () => {
    const roles = cell("roles");
    expect(roles.match(/data-slot="category-chip"/g)).toHaveLength(2);
    // each space role in its slot of the chip map (config checker 6, reviewer 6), as on the workflow editor
    expect(roles).toContain("bg-chart-6");
    expect(roles).not.toContain("bg-chart-2");
    expect(roles).toContain("Config checker");
    expect(roles).toContain("Reviewer");
    expect(cell("status")).toContain("Active");
    expect(cell("status", { ...M, active: false })).toContain("Inactive");
    expect(cell("username")).toMatch(/class="[^"]*font-mono[^"]*"[^>]*>rina\.h</);
    expect(cell("lastSignInAt")).toContain("Never");
    expect(cell("lastSignInAt", { ...M, lastSignInAt: "2026-11-18T02:00:00.000Z" })).toContain('dateTime="2026-11-18T02:00:00.000Z"');
  });
});
