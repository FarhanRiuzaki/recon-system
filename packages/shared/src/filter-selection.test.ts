import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readdirSync, readFileSync } from "node:fs";
import { canonicalSelection, MULTI_FILTER_KEYS, selectionState, selectionValues } from "./filter-selection";
import { filterSelection } from "./contracts/filter-selection";

describe("filter selections", () => {
  const names = filterSelection(z.string().min(1).max(64));
  it("canonicalizes exact values and roundtrips comma, Unicode and JSON-looking names without delimiter coercion", () => {
    const values = ["Design, Team", "日本", '["Admin"]', "Admin", "Admin", "admin"];
    expect(selectionValues(selectionState(values))).toEqual(canonicalSelection(values));
    expect(names.parse("Design, Team")).toEqual(["Design, Team"]);
    expect(names.parse('["Admin"]')).toEqual(['["Admin"]']);
    expect(names.parse("")).toEqual([]);
    expect(names.parse([])).toEqual([]);
  });
  it("validates all raw values before deduplication, including nested and non-string input", () => {
    expect(names.parse(Array(50).fill("Admin"))).toEqual(["Admin"]);
    for (const value of [Array(51).fill("Admin"), ["Admin", ""], [["Admin"]], [1], {}, null]) {
      expect(names.safeParse(value).success).toBe(false);
    }
    expect(filterSelection(z.enum(["active", "inactive"])).safeParse(["active", "invalid"]).success).toBe(false);
  });
});

describe("multi filter keys", () => {
  it("every contract query key read as a filterSelection keeps its repeats at the API and in saved views", () => {
    const dir = new URL("./contracts/", import.meta.url);
    const keys = readdirSync(dir).filter((f) => f.endsWith(".ts")).flatMap((f) => [...readFileSync(new URL(f, dir), "utf8").matchAll(/(\w+): filterSelection\(/g)].map((m) => m[1]!));
    expect(keys).toContain("checked");
    expect(keys.filter((k) => !(MULTI_FILTER_KEYS as readonly string[]).includes(k))).toEqual([]);
  });
});
