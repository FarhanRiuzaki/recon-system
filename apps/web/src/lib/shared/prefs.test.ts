import { describe, expect, it } from "vitest";
import { NAV } from "./nav";
import { columnsKey, parsePrefs, prefsCookie, savedView, VIEW_PAGES, viewHref, viewPageOf, DEFAULT_PREFS } from "./prefs";
import { sourceActivity, sourceFiles, sourceQuarantine, sourceRecords, sourceSnapshots, sourceVersions } from "./queries";
import { breakActivity, breakCandidates, reconActivity, reconSignoffs, reconVersions } from "./queries-recon";

const value = (cookie: string) => decodeURIComponent(cookie.split(";")[0]!.split("=").slice(1).join("="));

describe("prefs cookie", () => {
  it("remembers the last space, only as a UUID", () => {
    const id = "5b0c1f2e-0000-4000-8000-000000000000";
    const c = prefsCookie({ ...DEFAULT_PREFS, space: id }, false);
    expect(parsePrefs(value(c)).space).toBe(id);
    expect(parsePrefs("space=nope").space).toBeNull();
    expect(parsePrefs(undefined).space).toBeNull();
    expect(parsePrefs(value(prefsCookie({ ...DEFAULT_PREFS, space: "../x" }, false))).space).toBeNull();
  });
  it("round-trips compact density and collapsed sidebar", () => {
    const c = prefsCookie({ sidebar: "collapsed", density: "compact", views: {}, columns: {}, keys: "off", space: null }, false);
    expect(parsePrefs(value(c))).toEqual({ sidebar: "collapsed", density: "compact", views: {}, columns: {}, keys: "off", space: null });
  });
  it("missing or unknown values fall back to comfortable/expanded", () => {
    expect(parsePrefs(undefined)).toEqual({ sidebar: "expanded", density: "comfortable", views: {}, columns: {}, keys: "on", space: null });
    expect(parsePrefs("density=huge&sidebar=x")).toEqual({ sidebar: "expanded", density: "comfortable", views: {}, columns: {}, keys: "on", space: null });
  });
});

describe("remembered table views", () => {
  it("every remembered list page is a navigation page or below one (its link is the one that reopens the view)", () => {
    for (const p of VIEW_PAGES) expect(NAV.some((n) => p === n.href || p.startsWith(`${n.href}/`)), p).toBe(true);
  });
  it("a space's members page is one view for every space: the pattern /spaces/[spaceId]/members", () => {
    const [a, b] = ["5b0c1f2e-0000-4000-8000-00000000000a", "5b0c1f2e-0000-4000-8000-00000000000b"];
    expect(viewPageOf(`/spaces/${a}/members`)).toBe("/spaces/[spaceId]/members");
    expect(viewPageOf("/users")).toBe("/users");
    for (const p of ["/spaces", `/spaces/${a}`, `/spaces/${a}/members/x`, "/spaces//members", "/users/x"]) expect(viewPageOf(p), p).toBeNull();
    const prefs = { ...DEFAULT_PREFS, views: { "/spaces/[spaceId]/members": "pageSize=25&sort=-name" }, columns: { "/spaces/[spaceId]/members#members": { shown: [], hidden: ["username"] } } };
    expect(viewHref(`/spaces/${b}/members`, prefs)).toBe(`/spaces/${b}/members?pageSize=25&sort=-name`);
    const back = parsePrefs(value(prefsCookie(prefs, false)));
    expect(back.views).toEqual(prefs.views);
    expect(back.columns).toEqual(prefs.columns);
  });
  it("round-trip through the cookie for the list pages only", () => {
    const views = { "/users": "role=Admin&sort=-createdAt", "/audit/activity": "pageSize=50&range=30d" };
    expect(parsePrefs(value(prefsCookie({ sidebar: "expanded", density: "comfortable", views, columns: {}, keys: "on", space: null }, false))).views).toEqual(views);
    expect(parsePrefs(new URLSearchParams({ "view:/me": "a=1", "view:/users/x": "b=2" }).toString()).views).toEqual({});
  });
  it("a cookie value is normalized, drops the page, and an oversized one is ignored", () => {
    expect(parsePrefs(new URLSearchParams({ "view:/users": "page=3&status=active" }).toString()).views).toEqual({ "/users": "status=active" });
    expect(parsePrefs(new URLSearchParams({ "view:/users": `q=${"x".repeat(400)}` }).toString()).views).toEqual({});
  });
  it("savedView keeps filters, sort and page size, not the page or the search", () => {
    expect(savedView(new URLSearchParams("page=4&q=bima&role=Admin&sort=-createdAt&pageSize=50"), ["q"])).toBe("pageSize=50&role=Admin&sort=-createdAt");
    expect(savedView(new URLSearchParams("page=2&q=x"), ["q"])).toBe("");
  });
  it("viewHref reopens the saved view; the path itself never changes", () => {
    const prefs = { sidebar: "expanded" as const, density: "comfortable" as const, views: { "/users": "role=Admin" }, columns: {}, keys: "on" as const, space: null };
    expect(viewHref("/users", prefs)).toBe("/users?role=Admin");
    expect(viewHref("/roles", prefs)).toBe("/roles");
    expect(viewHref("/users", { ...prefs, views: { "/users": "a=%2F%2Fevil.com#x" } })).toBe("/users?a=%2F%2Fevil.com%23x");
  });
  it("column choices round-trip per table as changes against the defaults: +shown, -hidden", () => {
    const columns = { "/users#users": { shown: ["createdAt"], hidden: ["type", "created_at", "pay-ref"] } };
    const c = prefsCookie({ ...DEFAULT_PREFS, columns }, false);
    expect(new URLSearchParams(value(c)).get("columns:/users#users")).toBe("+createdAt,-type,-created_at,-pay-ref");
    expect(parsePrefs(value(c)).columns).toEqual(columns);
    // an empty choice is the defaults: not written, not read
    expect(parsePrefs(value(prefsCookie({ ...DEFAULT_PREFS, columns: { "/users#users": { shown: [], hidden: [] } } }, false))).columns).toEqual({});
    expect(parsePrefs("columns:/users%23users=").columns).toEqual({});
  });
  it("a column choice drops a bad key, an unknown page or table, more than 20 keys; the old cols: entries are ignored", () => {
    expect(parsePrefs(new URLSearchParams({ "columns:/users#users": "-type,-../x,-a b,+createdAt,type,-_x", "columns:/nope#x": "-type", "columns:/users#../x": "-type", "columns:/users": "-type" }).toString()).columns)
      .toEqual({ "/users#users": { shown: ["createdAt"], hidden: ["type"] } });
    expect(parsePrefs(new URLSearchParams({ "columns:/roles#roles": Array.from({ length: 30 }, (_, i) => `-c${i}`).join(",") }).toString()).columns["/roles#roles"]!.hidden).toHaveLength(20);
    // written before the choice was kept as changes: a full hidden list per page, which would cancel every defaultHidden column
    expect(parsePrefs("cols:/users=type,createdAt&cols:/roles=").columns).toEqual({});
    expect(value(prefsCookie(parsePrefs("cols:/users=type"), false))).not.toContain("cols:");
  });
  it("two tables on one page keep their own column choice (the key is the page and the table's last API path segment)", () => {
    const [s, i] = ["5b0c1f2e-0000-4000-8000-00000000000a", "5b0c1f2e-0000-4000-8000-00000000000b"];
    const pages = [
      ["/spaces/[spaceId]/sources/[sourceId]", [sourceFiles, sourceSnapshots, sourceRecords, sourceQuarantine, sourceVersions, sourceActivity]],
      ["/spaces/[spaceId]/recons/[configId]", [reconVersions, reconActivity, reconSignoffs]],
      ["/spaces/[spaceId]/breaks/[itemId]", [breakCandidates, breakActivity]],
    ] as const;
    for (const [page, defs] of pages) {
      const keys = defs.map((d) => columnsKey(page, d(s, i).path));
      expect(new Set(keys).size, page).toBe(keys.length);
      const columns = Object.fromEntries(keys.map((k, n) => [k, { shown: [], hidden: [`c${n}`] }]));
      expect(parsePrefs(value(prefsCookie({ ...DEFAULT_PREFS, columns }, false))).columns, page).toEqual(columns);
    }
    expect(columnsKey("/spaces/[spaceId]/sources/[sourceId]", sourceRecords(s, i).path)).toBe("/spaces/[spaceId]/sources/[sourceId]#records");
  });
});

it("activity entry never becomes remembered navigation, including legacy cookies and direct view replay", () => {
  const query = "actorId=actor&targetType=Legacy&targetId=A%20b&entry=incident&entry=other";
  expect(savedView(new URLSearchParams(query), [], "/audit/activity")).toBe("actorId=actor&targetId=A+b&targetType=Legacy");
  const prefs = { ...DEFAULT_PREFS, views: { "/audit/activity": query } };
  expect(viewHref("/audit/activity", prefs)).toBe("/audit/activity?actorId=actor&targetType=Legacy&targetId=A+b");
  const parsed = parsePrefs(`view%3A%2Faudit%2Factivity=${encodeURIComponent(query)}`);
  expect(parsed.views["/audit/activity"]).not.toContain("entry");
  expect(value(prefsCookie(prefs, false))).not.toContain("entry");
});
