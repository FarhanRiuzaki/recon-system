import "server-only";
import { signInHref } from "@starterkit/ui/lib/safe-path";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { cache } from "react";
import type { SpaceRowDto } from "@starterkit/shared/contracts/spaces";
import type { UserDto } from "@starterkit/shared/contracts/users";
import { pagePerm } from "@/lib/shared/nav";
import { spaceDetail } from "@/lib/shared/queries";
import type { PermissionName } from "@starterkit/shared/permissions";
import { mayDo } from "@starterkit/shared/spaces";
import { backendJson, v1Path } from "./backend";
import { authContext, getSession } from "./session";

/**
 * Page guard for server components (layouts, pages). No live session → sign-in, returning to the requested path
 * (proxy.ts sets `x-pathname`; signInHref keeps it only when internal). Missing permission → "Page not found", with
 * no hint that the page exists. Returns what the shell needs: the user, permissions, and the CSRF token. The user and
 * permissions come from authContext (one API call per request, shared with the layout and the title).
 */
/** Where a user whose password an admin set goes first: Security, with the password form. */
export const OWN_PASSWORD_PAGE = "/me/security";

export async function requirePagePermission(
  perm: PermissionName | null,
): Promise<{ user: UserDto; perms: PermissionName[]; csrf: string }> {
  const ctx = await authContext();
  if (!ctx) redirect(signInHref((await headers()).get("x-pathname")));
  // a password an admin set: the user sets their own first (the API refuses the rest, password_change_required)
  if (ctx.user.mustChangePassword && ((await headers()).get("x-pathname") ?? "/").split("?")[0] !== OWN_PASSWORD_PAGE) redirect(OWN_PASSWORD_PAGE);
  if (perm && !ctx.perms.includes(perm)) notFound();
  return { user: ctx.user, perms: ctx.perms, csrf: (await getSession()).csrf! };
}

/**
 * Metadata of a guarded page: its own title only for a viewer who may open it (pagePerm of the requested path); for
 * anyone else "Page not found", so neither the 404 answer nor the tab names the page.
 */
export async function guardedTitle(title: string): Promise<Metadata> {
  const need = pagePerm((await headers()).get("x-pathname") ?? "/");
  const ctx = need ? await authContext() : null;
  return { title: !need || ctx?.perms.includes(need) ? title : "Page not found" };
}

/** The space id of a `/spaces/<id>/…` path (query and hash ignored), else null. */
export const spaceIdOf = (pathname: string): string | null => /^\/spaces\/([^/?#]+)/.exec(pathname)?.[1] ?? null;
/**
 * A space page that shows the space's data (sources and below): it needs a role in the space, since the API answers
 * its data to members only; a space.view holder who is no member opens members, not these.
 */
export const spaceDataPage = (pathname: string): boolean => /^\/spaces\/[^/?#]+\/sources(\/|$|\?)/.test(pathname);
/** A space's workflows and one of them (/spaces/<id>/workflows[/<id>]). */
const workflowsPage = (pathname: string): boolean => /^\/spaces\/[^/?#]+\/workflows(\/|$|\?)/.test(pathname);

/**
 * What the caller may do with a space's workflows, as the API's guards let them: any member or a `workflow.view`
 * holder reads (`{ space: SPACE_ROLES, or: "workflow.view" }`); a space admin (SPACE_ACTION.editWorkflows) or a
 * `workflow.manage` holder edits, once they read. `space` is openSpace's answer (null: not a member, no space.view).
 */
export function workflowAccess(space: { roles: readonly string[] } | null, perms: readonly string[]): { read: boolean; manage: boolean } {
  const roles = space?.roles ?? [];
  const read = roles.length > 0 || perms.includes("workflow.view");
  return { read, manage: read && (mayDo(roles, "editWorkflows") || perms.includes("workflow.manage")) };
}

/**
 * Whether a space page answers "Page not found" before the page itself decides: the space doesn't open for the caller
 * (openSpace null) unless it is the workflows a `workflow.view` holder reads without a role in it, or a data page
 * (spaceDataPage) for someone with no role in it.
 */
export const spacePageRefused = (pathname: string, space: { roles: readonly string[] } | null, perms: readonly string[]): boolean =>
  space ? spaceDataPage(pathname) && !space.roles.length : !(workflowsPage(pathname) && workflowAccess(null, perms).read);

/**
 * The space as the caller may see it, read once per request (`cache`: the (main) layout, the page and its title share
 * it). Any signed-in user reaches `/spaces/<id>/…` (pagePerm null); the API decides membership: 403 (not a member, no
 * space.view) and 404 (no such space, an id that is not a UUID) both give null, so nothing names a space the caller
 * can't open. Another answer throws (error.tsx).
 */
export const openSpace = cache(async (id: string): Promise<SpaceRowDto | null> => {
  const path = v1Path(spaceDetail(id).url);
  if (!path) return null;
  const { status, data } = await backendJson<SpaceRowDto>(path, { token: (await getSession()).token, req: { headers: await headers() } });
  if (status === 403 || status === 404) return null;
  if (status !== 200 || !data) throw new Error(`GET /v1/spaces/:spaceId answered ${status}`);
  return data;
});
