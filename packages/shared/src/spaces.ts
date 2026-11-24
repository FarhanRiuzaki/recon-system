// Space roles, fixed in phase 1 (recon spec §11, §11b): a user may hold several in one space. Zod-free for client code.

export const SPACE_ROLES = ["space_admin", "source_admin", "config_maker", "config_checker", "operator", "reviewer", "viewer"] as const;
export type SpaceRole = (typeof SPACE_ROLES)[number];

/**
 * Who may do each space action: the API's `{ space }` guards name these lists (or SPACE_ROLES, any member) and the
 * Members page's role matrix draws its cells from them, so the screen and the API can't drift
 * (`apps/api/test/architecture/space-guards.test.ts`, `apps/web/src/features/spaces/role-matrix.test.ts`).
 */
export const SPACE_ACTION = {
  /** Take, set state, match, close and request postings, force matches, write-offs and undo (Unmatch item, Explain). */
  work: ["space_admin", "operator", "reviewer"],
  assign: ["space_admin", "reviewer"],
  signOff: ["space_admin", "reviewer"],
  runRecon: ["space_admin", "config_maker", "operator"],
  /** Create a recon, edit, send and delete its draft versions. */
  editRecon: ["config_maker"],
  simulate: ["config_maker"],
  deleteRecon: ["space_admin", "config_maker"],
  resultColumns: ["space_admin", "config_maker"],
  /** A recon version's posting payload from a break's data: who sets up or reviews the recon. */
  previewPosting: ["space_admin", "config_maker", "config_checker"],
  /** Approve or reject a recon or source version someone else made. */
  approveVersion: ["config_checker"],
  /** Create and delete sources, their connection and credentials, read the server's catalog, pull now. */
  connectSource: ["source_admin"],
  /** A source version's fields and mapping. */
  editSource: ["source_admin", "config_maker"],
  previewSource: ["source_admin", "config_maker", "config_checker"],
  shareSource: ["space_admin"],
  /** The space's name, its members and their roles (with `or: "space.manage"`). */
  manageMembers: ["space_admin"],
  /** The space's workflows (with `or: "workflow.manage"`). */
  editWorkflows: ["space_admin"],
} as const satisfies Record<string, readonly SpaceRole[]>;
export type SpaceAction = keyof typeof SPACE_ACTION;
/**
 * Whether one of `roles` (the caller's in a space) may do `action`: the web offers an action to exactly the roles its
 * API guard lets in, never a role list of its own (`apps/web/src/test/architecture.test.ts` "a space permission decision …").
 */
export const mayDo = (roles: readonly string[], action: SpaceAction): boolean =>
  roles.some((r) => (SPACE_ACTION[action] as readonly string[]).includes(r));

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
  space_admin: "Adds and removes members, changes roles, edits workflows and shares sources; also works, assigns and approves unmatch items and signs off days.",
  source_admin: "Sets up source connections and credentials, declares source fields and pulls sources. Sees recons and unmatch but can't change them.",
  config_maker: "Edits recon and source drafts, runs simulations and recons, sends drafts for approval.",
  config_checker: "Approves config and source versions that someone else made.",
  operator: "Works unmatch: takes items, matches, and requests postings, force matches, write-offs and undo matches. Runs a recon now.",
  reviewer: "Approves operators' requests, signs off business days, and assigns and works unmatch items.",
  viewer: "Sees recons, unmatch and explanations, and exports CSV.",
};

/** Why a member action is off (Build notes 01 final copy): the role checklist and the members page show them. */
export const SOURCE_ADMIN_REASON = "Only an app admin can grant or remove Source admin.";
export const LAST_SPACE_ADMIN = "A space needs at least one space admin.";
/** The sidebar's counts of a space (GET …/nav-counts) stop at this; past it the answer says `capped`. */
export const NAV_COUNT_CAP = 1000;
