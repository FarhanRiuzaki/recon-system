import { readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as q from "./queries";
import * as qr from "./queries-recon";
import { readTable, tableRequest } from "./table-state";

/**
 * Query keys start with the module that owns the data, so one invalidation by module refreshes all of it. The modules
 * are the API's (`apps/api/src/modules/<m>/`), so a new module's keys pass without editing this test.
 */
const MODULES = readdirSync(path.resolve(import.meta.dirname, "../../../../api/src/modules"), { withFileTypes: true })
  .filter((d) => d.isDirectory()).map((d) => d.name);

describe("query keys: one scheme", () => {
  it("every key and table key exported by queries.ts and queries-recon.ts starts with a module name", () => {
    const firsts = [...Object.entries(q), ...Object.entries(qr)].flatMap(([name, v]): [string, unknown][] => {
      if (Array.isArray(v)) return name.endsWith("_KEY") ? [[name, v[0]]] : [];
      if (v && typeof v === "object" && "key" in v) return [[name, Array.isArray(v.key) ? v.key[0] : v.key]];
      if (typeof v === "function" && v.length === 1) {
        const r = name === "dashboardRead" ? q.dashboardRead(new URLSearchParams("range=7d")) : (v as (x: string) => unknown)("x");
        if (Array.isArray(r)) return [[name, r[0]]];
        if (r && typeof r === "object" && "key" in r) return [[name, Array.isArray(r.key) ? r.key[0] : r.key]];
      }
      return [];
    });
    expect(firsts.length).toBeGreaterThan(10);
    expect(firsts.filter(([, k]) => !MODULES.includes(k as string))).toEqual([]);
  });
});

it("dashboard range uses the same dated request as its cache key, without refresh in the key", () => {
  const a = q.dashboardRead(new URLSearchParams("from=2026-11-01&to=2026-11-03&refresh=30"));
  expect(a).toEqual({ key: ["dashboard", "/api/dashboard?from=2026-11-01&to=2026-11-03"], path: "/api/dashboard?from=2026-11-01&to=2026-11-03" });
  expect(q.dashboardRead(new URLSearchParams("refresh=30"))).toEqual({ key: ["dashboard"], path: "/api/dashboard" });
});


it("relative timestamp filters stay in stable API paths and keys for refresh and SSR", () => {
  const params = new URLSearchParams({ start: "now-15m", end: "now", refresh: "30" });
  const read = q.dashboardRead(params);
  expect(read.path).toBe("/api/dashboard?start=now-15m&end=now");
  expect(read.key).toEqual(["dashboard", read.path]);
  const filters = { range: "7d" as const, from: "", to: "", start: "now-15m", end: "now", user: "Alex", event: "" as const, method: "" as const };
  expect(q.AUTH_LOG.params!(filters)).toMatchObject({ start: "now-15m", end: "now", user: "Alex" });
});

describe("reconRunItems: the request a results tab sends", () => {
  const passes = [{ accept: "auto", cardinality: "1:1" }, { accept: "suggest", cardinality: "N:1" }];
  const params = (f: Partial<qr.RunItemFilters>) => qr.reconRunItems("s", "c", "r", passes).params!({ pass: "", status: "", side: "", date: "", reason: "", carried: "", ...f });
  it("no tab = pass 1's pairs on the run's own dates: its own outcome, one row per group from side A", () => {
    expect(params({})).toEqual({ pass: "1", status: "matched", side: "a", date: "", reason: "", carried: "", dates: "own" });
  });
  it("a suggest pass shows its suggestions; an N:1 pass's single side is B", () => {
    expect(params({ pass: "2" })).toMatchObject({ pass: "2", status: "suggested", side: "b", dates: "own" });
  });
  it("the items a pass broke: both sides unless one is picked", () => {
    expect(params({ pass: "1", status: "break" })).toMatchObject({ pass: "1", status: "break", side: "" });
    expect(params({ pass: "1", status: "break", side: "b" })).toMatchObject({ pass: "1", status: "break", side: "b" });
  });
  it("Breaks is every break item of the run's own dates, no pass, narrowed by a reason", () => {
    expect(params({ status: "break" })).toEqual({ pass: "", status: "break", side: "", date: "", reason: "", carried: "", dates: "own" });
    expect(params({ status: "break", reason: "No counterpart" })).toMatchObject({ reason: "No counterpart", dates: "own" });
    // a reason left in the URL never narrows a pass tab or Waiting
    expect(params({ pass: "2", reason: "Duplicate" }).reason).toBe("");
    expect(params({ status: "open", reason: "Duplicate" }).reason).toBe("");
  });
  it("Waiting is the open items of the run's own dates, with no pass", () => {
    expect(params({ status: "open", side: "a" })).toEqual({ pass: "", status: "open", side: "a", date: "", reason: "", carried: "", dates: "own" });
  });
  it("every tab agrees on the dates: a picked date alone, Carried over the dates before the run's", () => {
    for (const tab of [{}, { pass: "2" }, { status: "open" }, { status: "break" }, { pass: "1", status: "break" }]) {
      expect(params({ ...tab, date: "2026-11-04" })).toMatchObject({ date: "2026-11-04", dates: "", carried: "" });
      expect(params({ ...tab, carried: "1" })).toMatchObject({ date: "", dates: "carried", carried: "" });
      expect(params(tab)).toMatchObject({ dates: "own" });
    }
  });
  it("a pair outcome ignores a side left in the URL", () => {
    expect(params({ pass: "1", status: "matched", side: "b" })).toMatchObject({ pass: "1", status: "matched", side: "a" });
  });
});

describe("lists that open on a default view (audit §5.2, §5.3)", () => {
  const request = <F extends Record<string, string>>(def: q.TableDef<F>, sp = "") => new URL(tableRequest(def.path, readTable(new URLSearchParams(sp), def.spec), def.spec, def.params).url, "http://x").searchParams;
  it("Posting asks for failed, timeout and not sent until a status is ticked or all is shown", () => {
    expect(request(q.ACTION_RUNS("s")).getAll("status")).toEqual(["failed", "not_sent", "timeout"]);
    expect(request(q.ACTION_RUNS("s"), "show=all").getAll("status")).toEqual([]);
    expect(request(q.ACTION_RUNS("s"), "status=posted").getAll("status")).toEqual(["posted"]);
  });
  it("Approvals asks for mine unless every request is shown; Unmatch opens on the largest amount", () => {
    expect(request(qr.APPROVALS("s")).get("mine")).toBe("1");
    expect(request(qr.APPROVALS("s"), "mine=0").get("mine")).toBeNull();
    // a link or saved view from before Waiting for me was the default: mine= (empty) meant every request
    expect(request(qr.APPROVALS("s"), "mine=").get("mine")).toBeNull();
    expect(readTable(new URLSearchParams("mine="), qr.APPROVALS("s").spec).mine).toBe("0");
    expect(request(qr.BREAKS("s")).get("sort")).toBe("-amount");
  });
});

describe("Today's count of approvals waiting for the viewer", () => {
  it("is the inbox's first page as it opens, under the inbox's own key", () => {
    const def = qr.APPROVALS("s");
    const { url } = tableRequest(def.path, readTable(new URLSearchParams(), def.spec), def.spec, def.params);
    expect(qr.myApprovals("s")).toEqual({ key: [def.key, url], url });
    expect(new URL(url, "http://x").searchParams.get("mine")).toBe("1");
  });
});
