import { SPACE_ROLES, type SpaceRole } from "@starterkit/shared/spaces";

/** Members of a space are managed by its space_admin, or by a holder of the global `space.manage` permission. */
export const canManageMembers = (actorRoles: readonly SpaceRole[], hasSpaceManage: boolean): boolean =>
  hasSpaceManage || actorRoles.includes("space_admin");

/** True when a role change gains or loses source_admin, which only a holder of `space.manage` may do (spec §11b). */
export const sourceAdminChanged = (before: readonly SpaceRole[], after: readonly SpaceRole[]): boolean =>
  before.includes("source_admin") !== after.includes("source_admin");

export const isSpaceRole = (x: unknown): x is SpaceRole => (SPACE_ROLES as readonly unknown[]).includes(x);
