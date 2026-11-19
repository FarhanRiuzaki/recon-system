// Space roles, fixed in phase 1 (recon spec §11, §11b): a user may hold several in one space. Zod-free for client code.

export const SPACE_ROLES = ["space_admin", "source_admin", "config_maker", "config_checker", "operator", "reviewer", "viewer"] as const;
export type SpaceRole = (typeof SPACE_ROLES)[number];

export const SPACE_STATUSES = ["active", "archived"] as const;
export type SpaceStatus = (typeof SPACE_STATUSES)[number];
export const SPACE_NAME_MAX = 100;
/** A space code: 2–32 of a-z, 0-9 and "-" (sent in any case, stored lower case). */
export const SPACE_CODE = /^[a-z0-9-]{2,32}$/;
