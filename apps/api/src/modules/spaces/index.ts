// Public API of the spaces module: its tables, the space-scoped transaction and a user's roles in a space.
export type { SpaceRole } from "@starterkit/shared/spaces";
export { canManageMembers, isSpaceRole } from "./rules";
export { spaceMembers, spaces } from "./schema";
export { spaceRolesOf, withSpace } from "./service";
