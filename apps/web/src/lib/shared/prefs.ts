import { REMEMBERED_VIEW_QUERY_MAX } from "@starterkit/shared/views";
import { canonicalFilterQuery } from "@starterkit/shared/filter-selection";
/**
 * `views`: the last table view (filters, sort, rows per page) of each list page, so the navigation reopens a list
 * as it was left (the server reads the cookie, so the page renders filtered on first paint). Never the page number or
 * the search text: those belong to one visit. `hidden`: the columns each list page's viewer hid (ColumnsMenu), so the
 * table renders without them on first paint. `keys`: single-key shortcuts ("G then a letter", "?") on or off (WCAG 2.1.4:
 * a character-key shortcut can be turned off); ⌘K has a modifier and stays. `space`: the last space opened (per browser).
 */
export type Prefs = {
  sidebar: "expanded" | "collapsed"; density: "comfortable" | "compact"; views: Partial<Record<ViewPage, string>>;
  hidden: Partial<Record<ViewPage, string[]>>; keys: "on" | "off"; space: string | null;
};
const isUuid = (v: string | null | undefined) => !!v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export const PREFS_COOKIE = "sk_prefs";
export const DEFAULT_PREFS: Prefs = { sidebar: "expanded", density: "comfortable", views: {}, hidden: {}, keys: "on", space: null };

/**
 * The list pages whose view is remembered (each a `useTableQuery` screen). A `[segment]` matches any one path segment,
 * so a space's members page keeps one view for every space (`viewPageOf`).
 */
export const VIEW_PAGES = [
  "/users", "/roles", "/permissions", "/audit/activity", "/audit/auth", "/projects", "/spaces/[spaceId]/members", "/spaces/[spaceId]/sources",
  "/spaces/[spaceId]/sources/[sourceId]", "/spaces/[spaceId]/recons", "/spaces/[spaceId]/recons/[configId]",
  "/spaces/[spaceId]/recons/[configId]/runs/[runId]",
] as const;
export type ViewPage = (typeof VIEW_PAGES)[number];
const VIEW_MAX = REMEMBERED_VIEW_QUERY_MAX; // characters per view: the whole cookie stays far under the 4 KB limit
/** Hidden column keys of one page: a column key's shape, at most 20 (anything else in the cookie is dropped). */
const hiddenKeys = (v: string | null): string[] => [...new Set((v ?? "").split(",").filter((k) => /^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(k)))].slice(0, 20);
const isViewPage = (p: string): p is ViewPage => (VIEW_PAGES as readonly string[]).includes(p);
const VIEW_PATTERNS = VIEW_PAGES.map((p) => [p, new RegExp(`^${p.replace(/\[\w+\]/g, "[^/]+")}$`)] as const);
/** The VIEW_PAGES entry a path is (`/spaces/<id>/members` → `/spaces/[spaceId]/members`), or null. */
export const viewPageOf = (path: string): ViewPage | null => VIEW_PATTERNS.find(([, re]) => re.test(path))?.[0] ?? null;

const viewParams = (path: string, raw: string | URLSearchParams) => { const q = new URLSearchParams(raw); if (path === "/audit/activity") q.delete("entry"); return q; };

/** A table's URL query as it is remembered: without the page and the search keys; "" = the defaults. */
export function savedView(sp: URLSearchParams, search: readonly string[] = [], path?: string): string {
  const q = viewParams(path ?? "", sp);
  for (const k of ["page", ...search]) q.delete(k);
  return canonicalFilterQuery(q).toString();
}

/** Viewer preference from the cookie value; anything unknown falls back to the default. */
export function parsePrefs(raw: string | undefined): Prefs {
  const q = new URLSearchParams(raw ?? "");
  const views: Prefs["views"] = {};
  const hidden: Prefs["hidden"] = {};
  for (const p of VIEW_PAGES) {
    const v = savedView(new URLSearchParams(q.get(`view:${p}`) ?? ""), [], p);
    if (v && v.length <= VIEW_MAX) views[p] = v;
    const h = hiddenKeys(q.get(`cols:${p}`));
    if (h.length) hidden[p] = h;
  }
  return {
    sidebar: q.get("sidebar") === "collapsed" ? "collapsed" : "expanded",
    density: q.get("density") === "compact" ? "compact" : "comfortable",
    views,
    hidden,
    keys: q.get("keys") === "off" ? "off" : "on",
    space: isUuid(q.get("space")) ? q.get("space") : null,
  };
}

export function prefsCookie(p: Prefs, secure: boolean): string {
  const q = new URLSearchParams({ sidebar: p.sidebar, density: p.density, keys: p.keys });
  if (p.space) q.set("space", p.space); // parsePrefs drops anything but a UUID
  for (const [page, raw] of Object.entries(p.views)) { const v = page === "/audit/activity" ? viewParams(page, raw ?? "").toString() : raw ?? ""; if (v && isViewPage(page) && v.length <= VIEW_MAX) q.set(`view:${page}`, v); }
  for (const [page, h] of Object.entries(p.hidden)) { const keys = hiddenKeys(h?.join(",") ?? null); if (keys.length && isViewPage(page)) q.set(`cols:${page}`, keys.join(",")); }
  return `${PREFS_COOKIE}=${encodeURIComponent(q.toString())}; Path=/; Max-Age=31536000; SameSite=Strict${secure ? "; Secure" : ""}`;
}

/** A navigation link to `href`, reopening its remembered view (the query is re-encoded, so it can't change the path). */
export function viewHref(href: string, prefs: Prefs): string {
  const page = viewPageOf(href);
  const v = page ? prefs.views[page] : undefined;
  const q = v ? viewParams(page!, v).toString() : "";
  return q ? `${href}?${q}` : href;
}
