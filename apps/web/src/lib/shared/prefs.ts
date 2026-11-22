import { REMEMBERED_VIEW_QUERY_MAX } from "@starterkit/shared/views";
import { canonicalFilterQuery } from "@starterkit/shared/filter-selection";
/**
 * `views`: the last table view (filters, sort, rows per page) of each list page, so the navigation reopens a list
 * as it was left (the server reads the cookie, so the page renders filtered on first paint). Never the page number or
 * the search text: those belong to one visit. `columns`: each table's column choice (ColumnsMenu),
 * so it renders without the hidden ones on first paint; keyed per table (`columnsKey`: two tables on one page choose
 * apart) and kept as changes against the table's defaults (`shown` = `defaultHidden` columns turned on, `hidden` = others
 * turned off), so a column added later as `defaultHidden` starts hidden; no entry = the defaults. `keys`: single-key shortcuts ("G then a letter", "?") on or off (WCAG 2.1.4:
 * a character-key shortcut can be turned off); ⌘K has a modifier and stays. `space`: the last space opened (per browser).
 */
export type Prefs = {
  sidebar: "expanded" | "collapsed"; density: "comfortable" | "compact"; views: Partial<Record<ViewPage, string>>;
  columns: Partial<Record<string, ColumnChoice>>; keys: "on" | "off"; space: string | null;
};
const isUuid = (v: string | null | undefined) => !!v && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export const PREFS_COOKIE = "sk_prefs";
export const DEFAULT_PREFS: Prefs = { sidebar: "expanded", density: "comfortable", views: {}, columns: {}, keys: "on", space: null };

/**
 * The list pages whose view is remembered (each a `useTableQuery` screen). A `[segment]` matches any one path segment,
 * so a space's members page keeps one view for every space (`viewPageOf`).
 */
export const VIEW_PAGES = [
  "/users", "/roles", "/permissions", "/audit/activity", "/audit/auth", "/projects", "/spaces/[spaceId]/members", "/spaces/[spaceId]/sources",
  "/spaces/[spaceId]/sources/[sourceId]", "/spaces/[spaceId]/recons", "/spaces/[spaceId]/recons/[configId]", "/spaces/[spaceId]/approvals", "/spaces/[spaceId]/breaks", "/spaces/[spaceId]/breaks/[itemId]",
  "/spaces/[spaceId]/recons/[configId]/runs/[runId]", "/spaces/[spaceId]/recons/[configId]/versions/[versionId]", "/spaces/[spaceId]/workflows", "/spaces/[spaceId]/workflows/[id]", "/integrations", "/spaces/[spaceId]/posting",
] as const;
export type ViewPage = (typeof VIEW_PAGES)[number];
const VIEW_MAX = REMEMBERED_VIEW_QUERY_MAX; // characters per view: the whole cookie stays far under the 4 KB limit
/** One table's column choice (the shape of ui/ds `ColumnChoice`). */
export type ColumnChoice = { shown: readonly string[]; hidden: readonly string[] };
const COLUMN_KEY = /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/;
/** A column choice of the cookie (`+shown,-hidden`): column-key shaped entries only, at most 20; null when empty. */
const choiceOf = (v: string | null): ColumnChoice | null => {
  const ok = [...new Set((v ?? "").split(","))].filter((e) => /^[+-]/.test(e) && COLUMN_KEY.test(e.slice(1))).slice(0, 20);
  const shown = ok.filter((e) => e[0] === "+").map((e) => e.slice(1)), hidden = ok.filter((e) => e[0] === "-").map((e) => e.slice(1));
  return shown.length || hidden.length ? { shown, hidden } : null;
};
const choiceValue = (c: ColumnChoice) => [...c.shown.map((k) => `+${k}`), ...c.hidden.map((k) => `-${k}`)].join(",");
/**
 * The column choice key of a table: its page and the last segment of its API path (`/users#users`,
 * `/spaces/[spaceId]/sources/[sourceId]#quarantine`). The path, not `TableSpec.ns`: tabs of one page (a source's
 * files, snapshots and records) share the plain paging keys but are separate tables.
 */
export const columnsKey = (page: ViewPage, apiPath: string) => `${page}#${apiPath.split("?")[0]!.split("/").pop()}`;
const isColumnsKey = (k: string) => { const i = k.lastIndexOf("#"); return i > 0 && isViewPage(k.slice(0, i)) && /^[a-z][a-z0-9-]{0,39}$/.test(k.slice(i + 1)); };
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
  const columns: Prefs["columns"] = {};
  // `columns:<page>#<table>`; the `cols:<page>` entries before it (a full hidden list per page) are ignored
  for (const [k, v] of q) { const c = k.startsWith("columns:") && isColumnsKey(k.slice(8)) ? choiceOf(v) : null; if (c) columns[k.slice(8)] = c; }
  for (const p of VIEW_PAGES) {
    const v = savedView(new URLSearchParams(q.get(`view:${p}`) ?? ""), [], p);
    if (v && v.length <= VIEW_MAX) views[p] = v;
  }
  return {
    sidebar: q.get("sidebar") === "collapsed" ? "collapsed" : "expanded",
    density: q.get("density") === "compact" ? "compact" : "comfortable",
    views,
    columns,
    keys: q.get("keys") === "off" ? "off" : "on",
    space: isUuid(q.get("space")) ? q.get("space") : null,
  };
}

export function prefsCookie(p: Prefs, secure: boolean): string {
  const q = new URLSearchParams({ sidebar: p.sidebar, density: p.density, keys: p.keys });
  if (p.space) q.set("space", p.space); // parsePrefs drops anything but a UUID
  for (const [page, raw] of Object.entries(p.views)) { const v = page === "/audit/activity" ? viewParams(page, raw ?? "").toString() : raw ?? ""; if (v && isViewPage(page) && v.length <= VIEW_MAX) q.set(`view:${page}`, v); }
  for (const [k, c] of Object.entries(p.columns)) { const v = c && isColumnsKey(k) ? choiceOf(choiceValue(c)) : null; if (v) q.set(`columns:${k}`, choiceValue(v)); }
  return `${PREFS_COOKIE}=${encodeURIComponent(q.toString())}; Path=/; Max-Age=31536000; SameSite=Strict${secure ? "; Secure" : ""}`;
}

/** A navigation link to `href`, reopening its remembered view (the query is re-encoded, so it can't change the path). */
export function viewHref(href: string, prefs: Prefs): string {
  const page = viewPageOf(href);
  const v = page ? prefs.views[page] : undefined;
  const q = v ? viewParams(page!, v).toString() : "";
  return q ? `${href}?${q}` : href;
}
