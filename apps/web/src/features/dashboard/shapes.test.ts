import { describe, expect, it } from "vitest";
import type { PermissionName } from "@starterkit/shared/permissions";
import { adminSection } from "./dashboard-model";
import { DASHBOARD_SHAPE } from "./shapes";

/** The sections RouteSkeleton keeps for a holder of `perms` (its perm / without gate). */
const kept = (...perms: PermissionName[]) => {
  const can = (p: PermissionName) => perms.includes(p);
  return DASHBOARD_SHAPE.filter((s) => (!s.perm || can(s.perm)) && (!s.without || !can(s.without)));
};
const ADMIN_START = DASHBOARD_SHAPE.findIndex((s) => s.perm);

describe("/ loading shape (M3)", () => {
  it("reserves the admin section for exactly the holders the page shows it to, in its loaded shape", () => {
    for (const perms of [[], ["role.view"], ["user.view"], ["audit.view"], ["user.view", "audit.view"]] as PermissionName[][]) {
      const extra = kept(...perms).length - ADMIN_START;
      expect(extra > 0).toBe(adminSection((p) => perms.includes(p)));
    }
    // user.view only: three tiles (no failed sign-ins), the chart row, no recent activity
    const userOnly = kept("user.view").slice(ADMIN_START);
    expect(userOnly.map((s) => [s.kind, s.kind === "kpi" ? s.count : null])).toEqual([["bar", null], ["kpi", 3], ["panels", null]]);
    // audit.view: four tiles and the recent activity table
    expect(kept("audit.view").slice(ADMIN_START).map((s) => [s.kind, s.kind === "kpi" ? s.count : null])).toEqual([["bar", null], ["kpi", 4], ["panels", null], ["table", null]]);
  });
});
