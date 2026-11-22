import { writeTableFromSearch } from "./raw-table-state";
import { describe, expect, it } from "vitest";
import { facetsRequest, historyMode, isoDate, multiChoice, oneOf, readTable, sortState, tableHref, tableRequest, tableView, text, toSortParam, type TableSpec, withCounts, withOtherTables, writeTable } from "./table-state";

const SPEC = {
  sorts: ["at", "login"], defaultSort: "-at", search: ["user"] as const,
  filters: { user: text(64), event: oneOf(["", "login_failed", "logout"] as const, ""), range: oneOf(["7d", "30d"] as const, "7d"), from: isoDate },
};
const read = (qs: string) => readTable(new URLSearchParams(qs), SPEC);

describe("multiple category URL state", () => {
  const spec = { sorts: ["name"], defaultSort: "name", filters: { role: multiChoice(), q: text(200) } };
  it("roundtrips repeated, comma, Unicode and JSON-looking legacy values as literal choices", () => {
    const params = new URLSearchParams();
    for (const role of ['["Admin"]', "Design, Team", "日本", "Design, Team"]) params.append("role", role);
    const state = readTable(params, spec);
    const request = tableRequest("/api/users", state, spec);
    expect(new URLSearchParams(request.filterQuery).getAll("role")).toEqual(["Design, Team", '["Admin"]', "日本"]);
    const changed = writeTable(state, { q: "person" }, spec)!;
    expect(changed.getAll("role")).toEqual(["Design, Team", '["Admin"]', "日本"]);
    expect(tableRequest("/api/users", readTable(changed, spec), spec).filterQuery).toContain("q=person");
  });
});

describe("readTable", () => {
  it("defaults: page 1, 15 rows, the spec's sort, each filter's fallback", () => {
    expect(read("")).toEqual({ page: 1, pageSize: 15, sort: "-at", user: "", event: "", range: "7d", from: "" });
  });

  it("reads valid values and falls back per key on bad ones", () => {
    expect(read("page=3&pageSize=50&sort=login&user=%20ann%20&event=logout&range=30d"))
      .toEqual({ page: 3, pageSize: 50, sort: "login", user: "ann", event: "logout", range: "30d", from: "" });
    expect(read("page=0&pageSize=10&sort=-password&event=boom&range=1y"))
      .toEqual({ page: 1, pageSize: 15, sort: "-at", user: "", event: "", range: "7d", from: "" });
    expect(read("page=abc").page).toBe(1);
    expect(read("page=2.5").page).toBe(1);
    expect(read("page=99999").page).toBe(1000);
    expect(read(`user=${"x".repeat(80)}`).user).toHaveLength(64);
    expect(read("from=2026-02-28").from).toBe("2026-02-28");
    for (const d of ["2026-02-30", "2026-2-1", "20261001", "2026-10-01T00:00", "x"]) expect(read(`from=${d}`).from).toBe("");
  });
});

describe("tableRequest (the query key the browser hook and the server prefetch share)", () => {
  it("filters first (empty ones dropped), then page, pageSize and sort", () => {
    expect(tableRequest("/api/audit/auth", read("user=ann&page=2"), SPEC)).toEqual({
      filterQuery: "user=ann&range=7d", url: "/api/audit/auth?user=ann&range=7d&page=2&pageSize=15&sort=-at",
    });
    expect(tableRequest("/api/audit/auth", read(""), { ...SPEC, filters: {} } as never).url).toBe("/api/audit/auth?page=1&pageSize=15&sort=-at");
  });
  it("`params` maps the URL filters to API parameters first", () => {
    const r = tableRequest("/api/x", read("range=30d"), SPEC, ({ range, ...f }) => ({ ...f, days: range === "30d" ? "30" : "7" }));
    expect(r.url).toBe("/api/x?days=30&page=1&pageSize=15&sort=-at");
  });
});

describe("writeTable", () => {
  const base = read("page=4&pageSize=25&user=ann");
  it("leaves defaults out of the URL", () => {
    expect(writeTable(read("page=2"), { page: 1 }, SPEC)!.toString()).toBe("");
    expect(writeTable(base, { page: 5 }, SPEC)!.toString()).toBe("page=5&pageSize=25&user=ann");
  });

  it("any change other than the page itself goes back to page 1", () => {
    expect(writeTable(base, { user: "bob" }, SPEC)!.get("page")).toBeNull();
    expect(writeTable(base, { pageSize: 50 }, SPEC)!.get("page")).toBeNull();
    expect(writeTable(base, { sort: "login" }, SPEC)!.toString()).toBe("pageSize=25&sort=login&user=ann");
    expect(writeTable(base, { range: "30d" }, SPEC)!.get("page")).toBeNull();
  });
});

describe("tableHref (a filter as a real link: the tab opens in a new tab too)", () => {
  it("the URL set() would go to, keeping the refresh and the page's other keys; the same URL when nothing changes", () => {
    const cur = new URLSearchParams("page=4&user=ann&refresh=30s&tab=x.y");
    expect(tableHref("/users", cur, { user: "bob" }, { spec: SPEC })).toBe("/users?user=bob&refresh=30s");
    expect(tableHref("/users", cur, { user: "ann" }, { spec: SPEC })).toBe("/users?page=4&user=ann&refresh=30s&tab=x.y");
    expect(tableHref("/users", new URLSearchParams(), { page: 1 }, { spec: SPEC })).toBe("/users");
  });
});

describe("writeTable: nothing changed, normalised values", () => {
  const base = read("page=4&user=ann");
  it("is null (no navigation, no page reset) when the patch changes nothing", () => {
    expect(writeTable(base, {}, SPEC)).toBeNull();
    expect(writeTable(base, { page: 4 }, SPEC)).toBeNull();
    expect(writeTable(base, { user: "ann" }, SPEC)).toBeNull();
    expect(writeTable(base, { user: "  ann " }, SPEC)).toBeNull(); // trimmed before comparing
  });
  it("writes filter values through their parser (trimmed text, valid choice or fallback)", () => {
    expect(writeTable(base, { user: "  bob  " }, SPEC)!.get("user")).toBe("bob");
    expect(writeTable(base, { event: "boom" as never }, SPEC)).toBeNull(); // falls back to "", which it already is
  });
});

describe("historyMode", () => {
  it("search keystrokes replace the history entry; every other committed change pushes one (Back undoes it)", () => {
    expect(historyMode({ user: "ann" }, SPEC)).toBe("replace");
    expect(historyMode({ page: 2 }, SPEC)).toBe("push");
    expect(historyMode({ event: "logout" }, SPEC)).toBe("push");
    expect(historyMode({ user: "ann", page: 1 }, SPEC)).toBe("push");
    expect(historyMode({ user: "ann" }, { ...SPEC, search: undefined })).toBe("push");
  });
});

describe("sort mapping", () => {
  it("'-key' ↔ { key, dir: 'desc' }", () => {
    expect(sortState("-at")).toEqual({ key: "at", dir: "desc" });
    expect(sortState("login")).toEqual({ key: "login", dir: "asc" });
    expect(toSortParam({ key: "at", dir: "desc" })).toBe("-at");
    expect(toSortParam({ key: "login", dir: "asc" })).toBe("login");
  });
});

describe("tableView (what a server table shows; no flicker)", () => {
  const page = (items: string[], total = 40, totalCapped = false) => ({ items, total, page: 1, pageSize: 15, totalCapped });
  const base = { isPending: false, isPlaceholderData: false, isFetching: false, error: null as unknown };
  it("first load: loading, nothing to count yet", () => {
    // disabled query, nothing cached: idle, so no permanent skeleton
    expect(tableView({ ...base, isPending: true, fetchStatus: "idle" }, 1)).toMatchObject({ rows: [], loading: false });
    expect(tableView({ ...base, isPending: true, isFetching: true }, 1)).toMatchObject({ rows: [], loading: true, busy: false, count: undefined });
  });
  it("next page or sort loading: the previous rows stay, dimmed busy, never back to the skeleton", () => {
    const v = tableView({ ...base, data: page(["a", "b"]), isPlaceholderData: true, isFetching: true }, 2);
    expect(v).toMatchObject({ rows: ["a", "b"], loading: false, busy: true, loadError: null, staleError: null });
  });
  it("a page past the end shows the loading shape (it moves to the last page), never an empty state", () => {
    expect(tableView({ ...base, data: { ...page([]), page: 9 } }, 9)).toMatchObject({ rows: [], loading: true, pastEnd: true });
  });
  it("errors: with placeholder or no data → loadError; with the shown rows still valid → staleError", () => {
    const e = new Error("x");
    expect(tableView({ ...base, error: e }, 1)).toMatchObject({ loadError: e, staleError: null });
    expect(tableView({ ...base, data: page(["a"]), isPlaceholderData: true, error: e }, 2)).toMatchObject({ loadError: e, staleError: null });
    expect(tableView({ ...base, data: page(["a"]), error: e }, 1)).toMatchObject({ loadError: null, staleError: e, rows: ["a"] });
  });
  it("count: formatted total, \"+\" when the server capped it", () => {
    expect(tableView({ ...base, data: page(["a"], 12345) }, 1).count).toBe("12,345");
    expect(tableView({ ...base, data: page(["a"], 100000, true) }, 1).count).toBe("100,000+");
  });
});


describe("raw exact filter edits", () => {
  const exact = (raw: string | null) => raw ?? "";
  const spec = { sorts: ["at", "actor"], defaultSort: "-at", filters: { actorId: exact, targetType: exact, targetId: exact, action: multiChoice() } };
  const keys = ["actorId", "targetType", "targetId"];
  it("unrelated edits retain explicitly empty and incomplete exact filters instead of broadening", () => {
    const source = new URLSearchParams("actorId=&targetType=user&page=4");
    const next = writeTableFromSearch(source, { sort: "at" }, spec, keys)!;
    expect(next.has("actorId")).toBe(true);
    expect(next.get("actorId")).toBe("");
    expect(next.get("targetType")).toBe("user");
    expect(next.has("targetId")).toBe(false);
    expect(next.has("page")).toBe(false);
  });
  it("explicitly clearing a normalized empty raw key still removes its presence and resets the page", () => {
    const next = writeTableFromSearch(new URLSearchParams("actorId=&page=4"), { actorId: "" }, spec, keys)!;
    expect(next).not.toBeNull();
    expect(next.has("actorId")).toBe(false);
    expect(next.has("page")).toBe(false);
  });
  it("a target pair clears atomically, preserving untouched raw actor values and unrelated context", () => {
    const next = writeTableFromSearch(new URLSearchParams("actorId=&targetType=user&targetId=&sort=actor&page=4"), { targetType: "", targetId: "" }, spec, keys)!;
    expect(next.get("actorId")).toBe("");
    expect(next.has("targetType")).toBe(false);
    expect(next.has("targetId")).toBe(false);
    expect(next.get("sort")).toBe("actor");
    expect(writeTableFromSearch(new URLSearchParams("actorId="), {}, spec, keys)).toBeNull();
  });
});

describe("two lists on one page (TableSpec.ns)", () => {
  const VERSIONS: TableSpec<Record<never, string>> = { sorts: ["version"], defaultSort: "-version", filters: {}, ns: "v" };
  const ACTIVITY: TableSpec<{ range: string }> = { sorts: [], defaultSort: "", filters: { range: oneOf(["7d", "90d"], "90d") }, ns: "a" };
  const RECORDS: TableSpec<{ q: string }> = { sorts: [], defaultSort: "", filters: { q: text(200) } };
  it("each pages on its own key; filters keep their plain names", () => {
    const sp = new URLSearchParams("tab=history&v.page=3&a.page=2&range=7d");
    expect([readTable(sp, VERSIONS).page, readTable(sp, ACTIVITY).page, readTable(sp, ACTIVITY).range]).toEqual([3, 2, "7d"]);
    expect(writeTable(readTable(sp, VERSIONS), { page: 4 }, VERSIONS)!.toString()).toBe("v.page=4");
  });
  it("writing one keeps the other's state and the tab; a filter it cleared stays cleared", () => {
    const current = new URLSearchParams("tab=history&v.page=3&a.page=2&range=7d");
    const next = withOtherTables(writeTable(readTable(current, VERSIONS), { page: 4 }, VERSIONS)!, current, VERSIONS);
    expect(Object.fromEntries(next)).toEqual({ "v.page": "4", tab: "history", "a.page": "2", range: "7d" });
    const cleared = withOtherTables(writeTable(readTable(current, ACTIVITY), { range: "90d" }, ACTIVITY)!, current, ACTIVITY);
    expect(Object.fromEntries(cleared)).toEqual({ tab: "history", "v.page": "3" });
    // a plain list beside a namespaced one keeps the namespaced keys
    const r = new URLSearchParams("q=abc&page=2&qr.page=5");
    expect(Object.fromEntries(withOtherTables(writeTable(readTable(r, RECORDS), { page: 3 }, RECORDS)!, r, RECORDS))).toEqual({ q: "abc", page: "3", "qr.page": "5" });
  });
});

describe("filter counts (facets)", () => {
  it("read at <list>/facets with the list's own filters, no paging", () => {
    expect(facetsRequest("/api/users", "status=active&status=inactive")).toBe("/api/users/facets?status=active&status=inactive");
    expect(facetsRequest("/api/users", "")).toBe("/api/users/facets");
  });
  it("each option gets its count (0 when the facet has none); none while the counts load", () => {
    const opts = [{ value: "new", label: "New" }, { value: "assigned", label: "Assigned" }];
    expect(withCounts(opts, { new: 4 })).toEqual([{ value: "new", label: "New", count: 4 }, { value: "assigned", label: "Assigned", count: 0 }]);
    expect(withCounts(opts, undefined)).toEqual(opts);
  });
});

