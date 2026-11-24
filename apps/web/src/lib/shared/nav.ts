import type { PermissionName } from "@starterkit/shared/permissions";
import { canonicalSelection } from "@starterkit/shared/filter-selection";
import { NAV_COUNT_CAP } from "@starterkit/shared/spaces";
import { formatNumber } from "@starterkit/ui/lib/format";

export type NavIcon = "dashboard" | "users" | "roles" | "permissions" | "activity" | "signin" | "ds" | "profile" | "projects" | "members"
  | "today" | "breaks" | "approvals" | "recons" | "sources" | "workflows" | "integrations" | "posting" | "results";
export type NavGroup = "main" | "work" | "setup" | "space" | "access" | "audit" | "personal";
/** Why a `soon` item is off, as the 64 px rail's tooltip (the group caption says it elsewhere; AGENTS.md §10). */
export const SOON_REASON = "Arrives in a later release.";
/**
 * One caption for a group's `soon` items, naming them: "Breaks arrives in a later release.", "Breaks and Exports arrive
 * in a later release."; null when it has none (the 64 px rail's tooltip says SOON_REASON beside the icon).
 */
export function soonCaption(items: readonly NavItem[]): string | null {
  const l = items.filter((n) => n.soon).map((n) => n.label);
  if (!l.length) return null;
  if (l.length === 1) return `${l[0]} arrives in a later release.`;
  return `${l.slice(0, -1).join(", ")} and ${l.at(-1)} arrive in a later release.`;
}
/**
 * `shortcut` is "" for an item without one; `perm` null = every signed-in user. `children`, listed under the item in
 * the sidebar while its section is open: views of its own page (same path, a filter in the query) or pages below it
 * (a sub-route: another path), which share the item's permission (`pagePerm`) and breadcrumb.
 * `soon`: a page of a later release, shown disabled (not a link, no shortcut, not in the palette). `hidden`: a
 * template page whose route still works (guard, breadcrumb) but that the navigation does not list.
 * `space`: a page every space has, at /spaces/<id>/<space>; `href` is its entry, which opens the current space's
 * (app/(main)/spaces/page.tsx, app/(main)/sources/page.tsx, app/(main)/recons/page.tsx, app/(main)/today/page.tsx), and the item is active on that page and below it.
 */
export type NavItem = {
  href: string; label: string; icon: NavIcon; shortcut: string; group: NavGroup; perm: PermissionName | null; children?: readonly NavChild[]; soon?: true; hidden?: true;
  space?: SpacePage;
};
/** The pages every space has (/spaces/<id>/<page>). */
export const SPACE_PAGES = ["members", "sources", "recons", "today", "approvals", "breaks", "workflows", "posting", "results"] as const;
export type SpacePage = (typeof SPACE_PAGES)[number];
export type NavChild = { href: string; label: string; icon?: NavIcon };
export type NavSection = { id: NavGroup; label: string; items: NavItem[] };

export const NAV: readonly NavItem[] = [
  { href: "/", label: "Dashboard", icon: "dashboard", shortcut: "G D", group: "main", perm: null },
  { href: "/results", label: "Operation result", icon: "results", shortcut: "G L", group: "main", perm: null, space: "results" },
  { href: "/today", label: "Today", icon: "today", shortcut: "G T", group: "work", perm: null, space: "today" },
  { href: "/breaks", label: "Unmatch", icon: "breaks", shortcut: "G H", group: "work", perm: null, space: "breaks" },
  { href: "/approvals", label: "Approvals", icon: "approvals", shortcut: "G V", group: "work", perm: null, space: "approvals" },
  { href: "/posting", label: "Posting", icon: "posting", shortcut: "G N", group: "work", perm: null, space: "posting" },
  { href: "/recons", label: "Recons", icon: "recons", shortcut: "G C", group: "setup", perm: null, space: "recons" },
  { href: "/sources", label: "Sources", icon: "sources", shortcut: "G O", group: "setup", perm: null, space: "sources" },
  { href: "/projects", label: "Projects", icon: "projects", shortcut: "", group: "main", perm: "project.view", hidden: true },
  { href: "/spaces", label: "Members", icon: "members", shortcut: "G E", group: "space", perm: null, space: "members" },
  { href: "/workflows", label: "Workflows", icon: "workflows", shortcut: "G W", group: "space", perm: null, space: "workflows" },
  { href: "/users", label: "Users", icon: "users", shortcut: "G U", group: "access", perm: "user.view" },
  { href: "/roles", label: "Roles", icon: "roles", shortcut: "G R", group: "access", perm: "role.view" },
  { href: "/permissions", label: "Permissions", icon: "permissions", shortcut: "G P", group: "access", perm: "permission.view" },
  { href: "/integrations", label: "Open API", icon: "integrations", shortcut: "G I", group: "access", perm: "integration.view" },
  { href: "/audit/activity", label: "Activity log", icon: "activity", shortcut: "G A", group: "audit", perm: "audit.view" },
  { href: "/audit/auth", label: "Sign-in log", icon: "signin", shortcut: "G S", group: "audit", perm: "audit.view" },
  { href: "/ds", label: "Design system", icon: "ds", shortcut: "", group: "personal", perm: null, hidden: true, children: [
    { href: "/ds", label: "Overview" }, { href: "/ds/foundations", label: "Foundations" }, { href: "/ds/components", label: "Components" },
    { href: "/ds/forms", label: "Forms" }, { href: "/ds/feedback", label: "Feedback" }, { href: "/ds/data", label: "Data display" },
    { href: "/ds/visuals", label: "Illustrations" }, { href: "/ds/motion", label: "Motion" },
  ] },
  { href: "/me", label: "Profile", icon: "profile", shortcut: "G M", group: "personal", perm: null },
];

const GROUPS: { id: NavGroup; label: string }[] = [
  { id: "main", label: "Main" }, { id: "work", label: "Work" }, { id: "setup", label: "Setup" }, { id: "space", label: "Space" }, { id: "access", label: "Access" }, { id: "audit", label: "Audit" }, { id: "personal", label: "Personal" },
];

/**
 * Sidebar sections for these permissions: items the user cannot open are left out, then empty groups. `noSpace` (the
 * caller is in no space) drops the Space group and every other page of a space (Sources), which all need a space,
 * unless they hold space.manage: /spaces is where they create one.
 */
export function navFor(perms: ReadonlySet<PermissionName>, noSpace = false): NavSection[] {
  const dropSpace = noSpace && !perms.has("space.manage");
  return GROUPS
    .filter((g) => !(dropSpace && g.id === "space"))
    .map((g) => ({ ...g, items: NAV.filter((n) => !n.hidden && n.group === g.id && !(dropSpace && n.space) && (n.perm === null || perms.has(n.perm))) }))
    .filter((s) => s.items.length > 0);
}

/** The openable pages (palette, "G" shortcuts, shortcut list): the sidebar's items (`noSpace` as in navFor) without the `soon` ones. */
export const pagesFor = (perms: ReadonlySet<PermissionName>, noSpace = false): NavItem[] => navFor(perms, noSpace).flatMap((s) => s.items).filter((n) => !n.soon);

/** `exact`: active only on its own path. "/" is always exact. */
export function isActive(pathname: string, href: string, exact = false): boolean {
  const p = pathname.split(/[?#]/)[0] ?? "/";
  return href === "/" || exact ? p === href : p === href || p.startsWith(`${href}/`);
}

/**
 * The space page a space entry (/spaces, /sources, /recons) opens: the remembered space (prefs `space`) while it is in
 * the list, else the first (the list is name A–Z); Sources, Recons and Today are a space's data, so for them only spaces the
 * caller holds a role in. Null: none. The entry pages redirect by it on the server, and the navigation links straight
 * to it once the switcher's list is in, so a client navigation never shows the redirect's empty page.
 */
/**
 * A version page opened from the approvals inbox carries `?from=approvals` (APPROVALS_FROM): after a decision it
 * goes back to the inbox of its space. The breadcrumb stays the version's own (Recons / name / Version n).
 */
export const APPROVALS_FROM = "approvals";
export const approvalsHref = (spaceId: string) => `/spaces/${encodeURIComponent(spaceId)}/approvals`;

export function spaceEntry(page: SpacePage, spaces: readonly { id: string; roles: readonly string[] }[], remembered: string | null, current: string | null = null): string | null {
  const id = page === "members" ? openSpace(spaces, remembered, current) : navSpaceId(spaces, remembered, current);
  return id ? `/spaces/${encodeURIComponent(id)}/${page}` : null;
}
// The space of the page being viewed wins: a link never leaves the space the user is working in.
const openSpace = (pool: readonly { id: string }[], remembered: string | null, current: string | null) =>
  (pool.find((s) => s.id === current) ?? pool.find((s) => s.id === remembered) ?? pool[0])?.id ?? null;
/** The space a space's data pages (Unmatch, Approvals, …) link to, as spaceEntry picks it: the one the sidebar's counts are for. */
export const navSpaceId = (spaces: readonly { id: string; roles: readonly string[] }[], remembered: string | null, current: string | null = null) =>
  openSpace(spaces.filter((s) => s.roles.length), remembered, current);

/** GET /api/spaces/<id>/nav-counts (NavCountsDto), as a type here so the shell imports no contract. */
export type NavCounts = { unmatch: number; approvals: number; posting: number; capped: boolean };
export type NavCountTone = "neutral" | "progress" | "down";
/** A nav item's live count: `text` on the badge ("99+" past 99), `name` for its link and tooltip ("" at 0: no badge). */
export type NavCount = { value: number; text: string; name: string; tone: NavCountTone };
/** Which space pages count, what: Approvals wait on the viewer (primary emphasis), Posting is a failure (down). */
const COUNTED: Partial<Record<SpacePage, { key: "unmatch" | "approvals" | "posting"; what: string; tone: NavCountTone }>> = {
  breaks: { key: "unmatch", what: "open", tone: "neutral" },
  approvals: { key: "approvals", what: "waiting for you", tone: "progress" },
  posting: { key: "posting", what: "need attention", tone: "down" },
};
export function navCount(page: SpacePage | undefined, c: NavCounts | undefined): NavCount | null {
  const m = page && COUNTED[page];
  if (!m || !c) return null;
  const value = c[m.key];
  const full = `${formatNumber(value)}${c.capped && value >= NAV_COUNT_CAP ? "+" : ""}`;
  return { value, text: countText(value), name: value ? `${full} ${m.what}` : "", tone: m.tone };
}
/**
 * The scrollTop that puts `item` (offsetTop measured in the container's scroll content) in the middle of the
 * container, within its scroll range; null while the item is already fully visible (the sidebar doesn't move then).
 */
export function centerScrollTop(c: { scrollTop: number; clientHeight: number; scrollHeight: number }, item: { offsetTop: number; offsetHeight: number }): number | null {
  if (item.offsetTop >= c.scrollTop && item.offsetTop + item.offsetHeight <= c.scrollTop + c.clientHeight) return null;
  const top = item.offsetTop + item.offsetHeight / 2 - c.clientHeight / 2;
  return Math.round(Math.max(0, Math.min(top, c.scrollHeight - c.clientHeight)));
}
/** A count badge's text: the number, "99+" past 99 (a frame of the roll may be fractional: rounded). */
export const countText = (v: number) => (v > 99 ? "99+" : String(Math.round(v)));
/** A nav link's accessible name: its label, then its count ("Unmatch, 37 open"). */
export const navLinkName = (label: string, c: NavCount | null) => (c?.name ? `${label}, ${c.name}` : label);

/** Whether the path is on nav item `n`'s page: its href or below; a space page only its own entry and /spaces/<id>/<space>[/…]. */
export function onItem(pathname: string, n: Pick<NavItem, "href" | "space">): boolean {
  if (!n.space) return isActive(pathname, n.href);
  const p = clean(pathname);
  return p === n.href || new RegExp(`^/spaces/[^/]+/${n.space}(/|$)`).test(p);
}

export type Crumb = { label: string; href?: string; icon?: NavIcon };

/**
 * The child of `item` the URL shows, or null. A sub-route child (its path differs from the item's): on its path or
 * below it; sibling sub-routes are not nested in each other. A child on the item's own path, only on that exact path:
 * the one whose query matches on every key its siblings filter by (other parameters such as the sort aside; a child
 * without the key matches its absence).
 */
export function activeChild(item: NavItem, pathname: string, sp: URLSearchParams): NavChild | null {
  const p = clean(pathname);
  const own = (c: NavChild) => c.href.split("?")[0] === item.href;
  if (p !== item.href) return item.children?.find((c) => !own(c) && isActive(p, c.href.split("?")[0]!)) ?? null;
  const views = item.children?.filter(own) ?? [];
  const q = (c: NavChild) => new URLSearchParams(c.href.split("?")[1] ?? "");
  const keys = [...new Set(views.flatMap((c) => [...q(c).keys()]))];
  return views.find((c) => keys.every((k) => JSON.stringify(canonicalSelection(q(c).getAll(k))) === JSON.stringify(canonicalSelection(sp.getAll(k))))) ?? null;
}

const clean = (pathname: string) => (pathname.split(/[?#]/)[0] ?? "/").replace(/\/+$/, "") || "/";
/** The nav page a path belongs to (hidden pages count, `soon` ones have no page yet; longest href wins, so /audit/auth is not /audit). */
const navItemOf = (p: string) => [...NAV].filter((n) => !n.soon).sort((a, b) => b.href.length - a.href.length).find((n) => onItem(p, n));

/**
 * Top bar breadcrumb: the nav page the path belongs to, only when the viewer may open it, so a page the role can't
 * open ("Page not found") doesn't name itself in the breadcrumb. A sub-page adds its own crumbs (PageHeader's trail).
 */
export function crumbs(pathname: string, perms: ReadonlySet<PermissionName>): Crumb[] {
  if (clean(pathname) === "/spaces") return []; // the no-space screen: "Members" would name a page the caller can't open
  const top = navItemOf(clean(pathname));
  return top && (top.perm === null || perms.has(top.perm)) ? [{ label: top.label, href: top.href, icon: top.icon }] : [];
}

/**
 * True on a page below its nav page (/users/<id>, /me/security, /spaces/<id>/sources/<id>): the nav crumb links back,
 * the page's own trail follows. A space's page (/spaces/<id>/members) is its nav page itself: the space is named in
 * the switcher, not the breadcrumb.
 */
export const isSubPage = (pathname: string) => {
  const p = clean(pathname);
  const top = navItemOf(p);
  return !!top && top.href !== p && !/^\/spaces\/[^/]+\/[^/]+$/.test(p);
};

/**
 * The permission a signed-in page needs, by path: its nav page's, with the finer rules of sub-pages (/users/new needs
 * user.create, /users/<id>/edit user.edit). The (main) layout answers a real 404 with it before streaming starts;
 * each page.tsx guards with the same (architecture.test.ts compares them), which covers client navigations.
 */
export function pagePerm(pathname: string): PermissionName | null {
  const p = clean(pathname);
  if (p === "/users/new") return "user.create";
  if (/^\/users\/[^/]+\/edit$/.test(p)) return "user.edit";
  if (p === "/projects/new") return "project.create";
  if (/^\/projects\/[^/]+\/edit$/.test(p)) return "project.edit";
  return navItemOf(p)?.perm ?? null;
}
