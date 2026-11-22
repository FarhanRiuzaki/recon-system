import { Elysia } from "elysia";
import { isSuperadmin, type PermissionName } from "@starterkit/shared/permissions";
import { SPACE_ROLES, type SpaceRole } from "@starterkit/shared/spaces";
import { db } from "../../kernel/db";
import { ApiError } from "../../kernel/errors";
import { idParam } from "../../kernel/parse";
import { type Client, context } from "../../kernel/plugins/context";
import { isSpaceArchived, spaceExists, spaceRolesOf } from "../spaces";
import { type AuthUser, resolveSession } from "./sessions";

/**
 * A route of `/v1/spaces/:spaceId/…`: the user holds one of `space` in that space, or, when `or` is given, that global
 * permission. Only a route that names `or` lets a non-member in (spec §11: a platform admin has no data access), so a
 * route with `or` is space management and never reads data through withSpace (conformance.test.ts). In an archived
 * space every other route answers a change (not GET/HEAD) 409 `space_archived`; reads and management still work.
 */
export type SpaceGuard = { space: readonly SpaceRole[]; or?: PermissionName };

/**
 * What a guarded handler knows about its request: the user, session, permissions, client and request id; with a
 * SpaceGuard also the space and the user's roles in it ([] when let in through `or`).
 */
export type Ctx = AuthUser & { client: Client; requestId: string; space?: { id: string; roles: SpaceRole[] } };

/** The session token of an `Authorization: Bearer <token>` header value, if any. */
export const bearer = (header: string | null | undefined): string | undefined => /^Bearer (\S+)$/i.exec(header ?? "")?.[1];

/**
 * What a user whose password an admin set may still do (403 password_change_required for the rest, after the 401 and
 * before the permission check): read their account and the app's context, change the password, sign out.
 */
const BEFORE_OWN_PASSWORD = new Set(["GET /v1/auth/context", "GET /v1/me", "POST /v1/me/password", "POST /v1/auth/logout"]);

/**
 * A bearer token → a live session (else 401 `unauthenticated`) → `perm` held (else 403 `forbidden`), before anything
 * else is read. `null` = any signed-in user. CSRF is checked by Next, not here.
 */
export async function authenticate(token: string | undefined, perm: PermissionName | null, route?: string): Promise<AuthUser> {
  const auth = token ? await resolveSession(token) : null;
  if (!auth) throw new ApiError("unauthenticated");
  // a password an admin set: the user's own first (`route` = "METHOD /path"; without one, as for OAuth linking, it's due too)
  if (auth.user.mustChangePassword && !(route && BEFORE_OWN_PASSWORD.has(route))) throw new ApiError("password_change_required");
  if (perm && !auth.perms.has(perm)) throw new ApiError("forbidden");
  return auth;
}

const READS = new Set(["GET", "HEAD"]);

/**
 * 401 without a live session; `params.spaceId` not a UUID → 404 before any space query; then 403 unless the user holds
 * one of `g.space` in that space or `g.or`; then, for a change on a route without `or`, 409 when the space is archived.
 * The roles are read per request, so a removed member is out on the next one. A Superadmin holds every space role in
 * every space that exists (owner rule, 22 Nov: isSuperadmin); a space that doesn't is 403 as for anyone.
 */
async function authenticateInSpace(token: string | undefined, g: SpaceGuard, spaceId: string | undefined, method: string, route: string): Promise<Pick<Ctx, keyof AuthUser | "space">> {
  const auth = await authenticate(token, null, route);
  const id = idParam(spaceId, "space");
  const roles = isSuperadmin(auth.user.roles) ? (await spaceExists(db, id) ? [...SPACE_ROLES] : []) : await spaceRolesOf(db, auth.user.id, id);
  if (!roles.some((r) => g.space.includes(r)) && !(g.or && auth.perms.has(g.or))) throw new ApiError("forbidden");
  if (!g.or && !READS.has(method) && await isSpaceArchived(db, id)) throw new ApiError("space_archived");
  return { ...auth, space: { id, roles } };
}

/**
 * Route option `guard: perm | null | SpaceGuard` (a resolve, so it runs after the query schema and before the
 * handler): the contract's order is query 400 → guard 401/403 → body 400 (`body()` in the handler) → 404 → rules →
 * change → activity. A SpaceGuard answers a non-UUID `:spaceId` 404 inside the guard (after 401, before 403). The
 * handler reads `ctx`.
 */
export const guard = new Elysia({ name: "auth.guard" }).use(context).macro({
  guard: (g: PermissionName | null | SpaceGuard) => ({
    resolve: async ({ request, client, requestId, params }) => {
      const token = bearer(request.headers.get("authorization"));
      const route = `${request.method} ${new URL(request.url).pathname}`;
      const auth = g !== null && typeof g === "object" ? await authenticateInSpace(token, g, (params as Record<string, string | undefined>).spaceId, request.method, route) : await authenticate(token, g, route);
      return { ctx: { ...auth, client, requestId } satisfies Ctx as Ctx };
    },
  }),
});
