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
  const params = (f: Partial<qr.RunItemFilters>) => qr.reconRunItems("s", "c", "r", passes).params!({ pass: "", status: "", side: "", date: "", reason: "", ...f });
  it("no tab = pass 1's pairs: its own outcome, one row per group from side A", () => {
    expect(params({})).toEqual({ pass: "1", status: "matched", side: "a", date: "", reason: "" });
  });
  it("a suggest pass shows its suggestions; an N:1 pass's single side is B", () => {
    expect(params({ pass: "2" })).toEqual({ pass: "2", status: "suggested", side: "b", date: "", reason: "" });
  });
  it("the items a pass broke: both sides unless one is picked", () => {
    expect(params({ pass: "1", status: "break" })).toEqual({ pass: "1", status: "break", side: "", date: "", reason: "" });
    expect(params({ pass: "1", status: "break", side: "b" })).toEqual({ pass: "1", status: "break", side: "b", date: "", reason: "" });
  });
  it("Breaks is every break item of the run's own dates, no pass, narrowed by a reason", () => {
    expect(params({ status: "break" })).toEqual({ pass: "", status: "break", side: "", date: "", reason: "", own: "1" });
    expect(params({ status: "break", reason: "No counterpart" })).toEqual({ pass: "", status: "break", side: "", date: "", reason: "No counterpart", own: "1" });
    // a reason left in the URL never narrows a pass tab or Waiting
    expect(params({ pass: "2", reason: "Duplicate" }).reason).toBe("");
    expect(params({ status: "open", reason: "Duplicate" }).reason).toBe("");
  });
  it("Waiting is the open items, with no pass; the date passes through", () => {
    expect(params({ status: "open", side: "a", date: "2026-11-04", reason: "" })).toEqual({ pass: "", status: "open", side: "a", date: "2026-11-04", reason: "" });
  });
  it("a pair outcome ignores a side left in the URL", () => {
    expect(params({ pass: "1", status: "matched", side: "b" })).toEqual({ pass: "1", status: "matched", side: "a", date: "", reason: "" });
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
    expect(request(qr.BREAKS("s")).get("sort")).toBe("-amount");
  });
});
