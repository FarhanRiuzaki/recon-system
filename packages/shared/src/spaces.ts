// Space roles, fixed in phase 1 (recon spec §11, §11b): a user may hold several in one space. Zod-free for client code.

export const SPACE_ROLES = ["space_admin", "source_admin", "config_maker", "config_checker", "operator", "reviewer", "viewer"] as const;
export type SpaceRole = (typeof SPACE_ROLES)[number];

export const SPACE_STATUSES = ["active", "archived"] as const;
export type SpaceStatus = (typeof SPACE_STATUSES)[number];
export const SPACE_NAME_MAX = 100;
/** A space code: 2–32 of a-z, 0-9 and "-" (sent in any case, stored lower case). */
export const SPACE_CODE = /^[a-z0-9-]{2,32}$/;

export const ROLE_LABEL: Record<SpaceRole, string> = {
  space_admin: "Space admin", source_admin: "Source admin", config_maker: "Config maker", config_checker: "Config checker",
  operator: "Operator", reviewer: "Reviewer", viewer: "Viewer",
};
export const ROLE_DESCRIPTION: Record<SpaceRole, string> = {
  space_admin: "Adds and removes members, changes roles, approves write-offs above the reviewer limit and reopened days.",
  source_admin: "Sets up source connections and credentials, and declares source fields. No access to recon config or breaks.",
  config_maker: "Edits config drafts and source mappings, runs simulations, sends them for approval.",
  config_checker: "Approves config and source versions that someone else made.",
  operator: "Works breaks: assigns, matches, and requests force matches, unmatches and write-offs.",
  reviewer: "Approves operators' requests and signs off business days.",
  viewer: "Sees recons, breaks and explanations, and exports CSV.",
};

/** Why a member action is off (Build notes 01 final copy): the role checklist and the members page show them. */
export const SOURCE_ADMIN_REASON = "Only an app admin can grant or remove Source admin.";
export const LAST_SPACE_ADMIN = "A space needs at least one space admin.";
