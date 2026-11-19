// Public API of the spaces module: its routes, its tables, the space-scoped transaction and a user's roles in a space.
export type { SpaceRole } from "@starterkit/shared/spaces";
export { spacesController } from "./controller";
export { canManageMembers, isSpaceRole } from "./rules";
export { spaceMembers, spaces } from "./schema";
export { assertNotLastSpaceAdmin, isSpaceArchived, spaceNames, spaceRolesOf, withSpace } from "./service";
