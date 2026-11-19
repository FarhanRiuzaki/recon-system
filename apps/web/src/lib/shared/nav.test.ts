import { describe, expect, it } from "vitest";
import { activeChild, crumbs, isActive, isSubPage, NAV, navFor, pagePerm, pagesFor, SOON_REASON, type NavItem } from "./nav";
import { DEFAULT_PREFS, viewHref } from "./prefs";
import { PERMISSIONS } from "@starterkit/shared/permissions";

const SOON = ["Today", "Breaks", "Approvals", "Recons", "Sources"];
const labels = (perms: Parameters<typeof navFor>[0]) => navFor(perms).flatMap((s) => s.items.map((i) => i.label));

describe("navFor", () => {
  it("user.view sees Dashboard, the coming-soon items, Members, Users, Profile only", () => {
    expect(labels(new Set(["user.view"]))).toEqual(["Dashboard", ...SOON, "Members", "Users", "Profile"]);
  });

  it("no permissions: items without a permission only; empty groups disappear", () => {
    const sections = navFor(new Set());
    expect(sections.map((s) => s.id)).toEqual(["main", "work", "setup", "space", "personal"]);
    expect(labels(new Set())).toEqual(["Dashboard", ...SOON, "Members", "Profile"]);
  });

  it("all permissions: every item but the hidden template pages, groups in the designed order", () => {
    const all = NAV.filter((n) => !n.hidden).map((n) => n.label);
    expect(all).toEqual(["Dashboard", ...SOON, "Members", "Users", "Roles", "Permissions", "Activity log", "Sign-in log", "Profile"]);
    expect(labels(new Set(PERMISSIONS))).toEqual(all);
    expect(navFor(new Set(PERMISSIONS)).map((s) => s.id)).toEqual(["main", "work", "setup", "space", "access", "audit", "personal"]);
  });

  it("Projects and Design system are not in the navigation, but their routes stay guarded and in the breadcrumb", () => {
    const all = labels(new Set(PERMISSIONS));
    expect(all).not.toContain("Projects");
    expect(all).not.toContain("Design system");
    expect(pagePerm("/projects")).toBe("project.view");
    expect(pagePerm("/projects/new")).toBe("project.create");
    expect(pagePerm("/ds/forms")).toBeNull();
    expect(crumbs("/projects", new Set(PERMISSIONS)).map((c) => c.label)).toEqual(["Projects"]);
    expect(crumbs("/projects", new Set())).toEqual([]);
  });

  it("coming-soon items: no shortcut, no permission, not in the palette or shortcut list, no page behind them", () => {
    const soon = NAV.filter((n) => n.soon);
    expect(soon.map((n) => [n.group, n.label])).toEqual([["work", "Today"], ["work", "Breaks"], ["work", "Approvals"], ["setup", "Recons"], ["setup", "Sources"]]);
    expect(soon.every((n) => n.shortcut === "" && n.perm === null)).toBe(true);
    const pages = pagesFor(new Set(PERMISSIONS));
    expect(pages.some((n) => n.soon || n.hidden)).toBe(false);
    expect(pages.map((n) => n.label)).not.toContain("Today");
    expect(pagePerm("/today")).toBeNull();
    expect(crumbs("/today", new Set(PERMISSIONS))).toEqual([]);
    expect(SOON_REASON).toMatch(/^Coming soon/);
  });

  it("shortcuts are unique", () => {
    const keys = NAV.map((n) => n.shortcut).filter(Boolean);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("space group", () => {
  it("in no space: the Space group is gone, other permitted items stay; a space.manage holder keeps it (Create space on /spaces)", () => {
    const admin = new Set(["user.view", "role.view", "space.view"] as const);
    expect(navFor(admin, true).flatMap((s) => s.items.map((i) => i.label))).toEqual(["Dashboard", ...SOON, "Users", "Roles", "Profile"]);
    expect(navFor(new Set(), true).map((s) => s.id)).toEqual(["main", "work", "setup", "personal"]);
    expect(navFor(new Set(["space.manage"]), true).map((s) => s.id)).toContain("space");
    expect(navFor(new Set(), false).map((s) => s.id)).toContain("space");
  });

  it("Members is in the Space group for every signed-in user and is active below /spaces/<id>/members", () => {
    const s = navFor(new Set()).find((x) => x.label === "Space");
    expect(s?.items.map((i) => [i.label, i.href, i.soon])).toEqual([["Members", "/spaces", undefined]]);
    expect(isActive("/spaces", "/spaces")).toBe(true);
    expect(isActive("/spaces/5b0c1f2e-0000-4000-8000-000000000000/members", "/spaces")).toBe(true);
  });
});

describe("isActive / crumbs", () => {
  it("/ is active only on /; others match sub-paths", () => {
    expect(isActive("/users/u-1", "/")).toBe(false);
    expect(isActive("/users/u-1", "/users")).toBe(true);
    expect(isActive("/usersx", "/users")).toBe(false);
  });
  it("breadcrumb: the nav page the path belongs to, then nothing for unknown; a sub-page is one below its nav page", () => {
    const all = new Set(PERMISSIONS);
    expect(crumbs("/audit/activity", all).map((c) => [c.label, c.href])).toEqual([["Activity log", "/audit/activity"]]);
    expect(crumbs("/users/u-1", all).map((c) => c.label)).toEqual(["Users"]);
    expect(crumbs("/nope", all)).toEqual([]);
    expect([isSubPage("/users"), isSubPage("/users/u-1"), isSubPage("/me/security"), isSubPage("/"), isSubPage("/nope")]).toEqual([false, true, true, false, false]);
    // A space's page is its nav page itself (the space is in the switcher): the breadcrumb is just "Members".
    expect(crumbs("/spaces/s-1/members", all).map((c) => c.label)).toEqual(["Members"]);
    expect(crumbs("/spaces", all)).toEqual([]); // the no-space screen: no "Members" for a page the caller cannot open
    expect(isSubPage("/spaces/s-1/members")).toBe(false);
  });
  it("breadcrumb: a page the viewer can't open doesn't name itself", () => {
    expect(crumbs("/roles", new Set(["user.view"]))).toEqual([]);
    expect(crumbs("/roles/role-admin", new Set(["user.view"]))).toEqual([]);
    expect(crumbs("/users/u-1", new Set(["user.view"])).map((c) => c.label)).toEqual(["Users"]);
  });
});

describe("pagePerm", () => {
  it("is the nav page's permission, with the finer rules for creating and editing users", () => {
    expect(pagePerm("/")).toBeNull();
    expect(pagePerm("/me/security")).toBeNull();
    expect(pagePerm("/users?page=2")).toBe("user.view");
    expect(pagePerm("/users/u-1")).toBe("user.view");
    expect(pagePerm("/users/new")).toBe("user.create");
    expect(pagePerm("/users/u-1/edit/")).toBe("user.edit");
    expect(pagePerm("/roles/role-admin")).toBe("role.view");
    expect(pagePerm("/permissions")).toBe("permission.view");
    expect(pagePerm("/audit/auth")).toBe("audit.view");
    expect(pagePerm("/nope")).toBeNull();
    expect(pagePerm("/spaces/5b0c1f2e-0000-4000-8000-000000000000/members")).toBeNull(); // membership: page.tsx asks the API
  });
});

describe("nav children", () => {
  const users = NAV.find((n) => n.href === "/users")!;
  it("Users has one navigation entry; its status views remain URL filters and the remembered view is preserved", () => {
    expect(users.children).toBeUndefined();
    expect(users.shortcut).toBe("G U");
    expect(navFor(new Set(PERMISSIONS)).flatMap(s => s.items).filter(n => n.href === "/users")).toHaveLength(1);
    const query = "pageSize=25&role=Viewer&status=active&status=inactive";
    expect(viewHref(users.href, { ...DEFAULT_PREFS, views: { "/users": query } })).toBe(`/users?${query}`);
  });
  it("activeChild remains available for another module with named child views", () => {
    const item: NavItem = { ...users, children: [
      { href: "/users", label: "All", icon: "users" },
      { href: "/users?status=inactive", label: "Inactive", icon: "users" },
    ] };
    expect(activeChild(item, "/users", new URLSearchParams(""))?.label).toBe("All");
    expect(activeChild(item, "/users", new URLSearchParams("status=inactive&sort=-createdAt&page=2"))?.label).toBe("Inactive");
    expect(activeChild(item, "/users", new URLSearchParams("role=Admin"))?.label).toBe("All");
    expect(activeChild(item, "/users/u-1", new URLSearchParams(""))).toBeNull();
  });

  const ds = NAV.find((n) => n.href === "/ds")!;
  const none = new URLSearchParams("");
  it("Design system lists its eight pages in order, without icons", () => {
    expect(ds.children?.map((c) => [c.label, c.href])).toEqual([
      ["Overview", "/ds"], ["Foundations", "/ds/foundations"], ["Components", "/ds/components"], ["Forms", "/ds/forms"],
      ["Feedback", "/ds/feedback"], ["Data display", "/ds/data"], ["Illustrations", "/ds/visuals"], ["Motion", "/ds/motion"],
    ]);
    expect(ds.children?.some((c) => c.icon)).toBe(false);
    expect(NAV.filter((n) => n.children).map((n) => n.href)).toEqual(["/ds"]);
  });
  it("a sub-route child is active on its path and below it; the child on the parent's path only on that exact path", () => {
    expect(activeChild(ds, "/ds", none)?.label).toBe("Overview");
    expect(activeChild(ds, "/ds/", new URLSearchParams("q=button"))?.label).toBe("Overview");
    expect(activeChild(ds, "/ds/forms", none)?.label).toBe("Forms");
    expect(activeChild(ds, "/ds/forms/x", none)?.label).toBe("Forms");
    expect(activeChild(ds, "/ds/forms/?tab=a#ds-time", none)?.label).toBe("Forms");
    expect(activeChild(ds, "/ds/data", none)?.label).toBe("Data display");
    expect(activeChild(ds, "/ds/formsx", none)).toBeNull();
    expect(activeChild(ds, "/ds/affect", none)).toBeNull();
    expect(activeChild(ds, "/users", none)).toBeNull();
  });
  it("sub-route and query children mix: a sub-route child never matches on the parent's own path", () => {
    const item: NavItem = { ...users, children: [
      { href: "/users/archive", label: "Archive" },
      { href: "/users", label: "All" },
      { href: "/users?status=inactive", label: "Inactive" },
    ] };
    expect(activeChild(item, "/users", none)?.label).toBe("All");
    expect(activeChild(item, "/users", new URLSearchParams("status=inactive"))?.label).toBe("Inactive");
    expect(activeChild(item, "/users/archive/2024", new URLSearchParams("status=inactive"))?.label).toBe("Archive");
    expect(activeChild(item, "/users/u-1", none)).toBeNull();
  });
  it("the breadcrumb and the page permission of a child page are its nav page's", () => {
    expect(crumbs("/ds/forms", new Set()).map((c) => [c.label, c.href])).toEqual([["Design system", "/ds"]]);
    expect([isSubPage("/ds"), isSubPage("/ds/forms")]).toEqual([false, true]);
    expect(pagePerm("/ds/motion")).toBeNull();
  });
});
