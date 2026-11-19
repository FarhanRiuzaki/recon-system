// Space roles, fixed in phase 1 (recon spec §11, §11b): a user may hold several in one space. Zod-free for client code.

export const SPACE_ROLES = ["space_admin", "source_admin", "config_maker", "config_checker", "operator", "reviewer", "viewer"] as const;
export type SpaceRole = (typeof SPACE_ROLES)[number];
