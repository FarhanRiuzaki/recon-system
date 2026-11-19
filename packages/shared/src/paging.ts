// Table paging limits shared by the contracts (zod, server) and the browser's table state (no zod in client bundles).

/** Rows per page a list endpoint accepts; the first is the default. */
export const PAGE_SIZES = [15, 25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];
export const DEFAULT_PAGE_SIZE: PageSize = 15;
/** Deepest page a list serves; deeper is 400 (narrow the filters instead). */
export const MAX_PAGE = 1000;

// Sort keys each list endpoint whitelists (the zod contracts take them through `sortParam`; screens put them in their
// TableSpec). The audit logs keep theirs in audit.ts.
export const USER_SORTS = ["name", "email", "lastLoginAt", "createdAt"] as const;
export const ROLE_SORTS = ["name", "permissions", "users"] as const;
/** GET /api/users/roles (role options for pickers). */
export const ROLE_OPTION_SORTS = ["name"] as const;
/** `module` = catalog order (module by module, as the matrix lists them). */
export const PERMISSION_SORTS = ["module", "name", "action"] as const;
export const SESSION_SORTS = ["lastSeenAt", "device"] as const;
export const PROJECT_SORTS = ["name", "createdAt"] as const;
export const SPACE_SORTS = ["name", "createdAt"] as const;
export const SPACE_MEMBER_SORTS = ["name"] as const;
export const SPACE_CANDIDATE_SORTS = ["name"] as const;
export const USER_SPACE_SORTS = ["name"] as const;
export const SAVED_VIEW_SORTS = ["name", "createdAt"] as const;
export const SOURCE_SORTS = ["name", "createdAt"] as const;
/** GET /api/spaces/{spaceId}/sources/{sourceId}/versions (newest version first by default). */
export const SOURCE_VERSION_SORTS = ["version", "updatedAt"] as const;
