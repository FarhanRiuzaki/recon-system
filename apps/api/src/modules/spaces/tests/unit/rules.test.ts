import { describe, expect, it } from "bun:test";
import { SPACE_ROLES } from "@starterkit/shared/spaces";
import { canManageMembers, isSpaceRole } from "../../rules";

describe("canManageMembers", () => {
  it("a space_admin of the space, or anyone with space.manage", () => {
    expect(canManageMembers(["space_admin"], false)).toBe(true);
    expect(canManageMembers(["operator", "space_admin"], false)).toBe(true);
    expect(canManageMembers([], true)).toBe(true);
  });

  it("no other role manages members, source_admin and config roles included", () => {
    expect(canManageMembers([], false)).toBe(false);
    expect(canManageMembers(SPACE_ROLES.filter((r) => r !== "space_admin"), false)).toBe(false);
  });
});

describe("isSpaceRole", () => {
  it("the seven roles, nothing else", () => {
    expect(SPACE_ROLES).toEqual(["space_admin", "source_admin", "config_maker", "config_checker", "operator", "reviewer", "viewer"]);
    expect(SPACE_ROLES.every(isSpaceRole)).toBe(true);
    for (const x of ["Space_Admin", "admin", "", " viewer", null, undefined, 1, ["viewer"], "toString", "constructor"]) expect(isSpaceRole(x)).toBe(false);
  });
});
