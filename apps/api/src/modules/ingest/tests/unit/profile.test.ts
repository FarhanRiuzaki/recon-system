import { describe, expect, it } from "bun:test";
import { profile } from "../../profile";

describe("profile", () => {
  const cols = ["sid", "n", "amt", "d", "ts", "flag", "note"];
  const rows = [
    ["TSTSID000000001", "1", "100.50", "2026-11-02", "2026-11-02T01:00:00Z", "true", "a"],
    ["TSTSID000000002", "20", "7", "2026-11-03", "2026-11-02T02:00:00Z", "false", ""],
    ["TSTSID000000003", "300", "1.5", "2026-11-04", "2026-11-02T03:00:00Z", "true", "a"],
    ["0000123", "4", "2.25", "20261105", "2026-11-02T04:00:00Z", "false", ""],
  ];
  const p = profile(cols, rows);
  it("guesses types, keeps leading-zero digit strings as text", () => {
    expect(p.map((c) => c.type)).toEqual(["string", "integer", "decimal", "date", "datetime", "boolean", "string"]);
    expect(profile(["x"], [["0000123"], ["0000456"]])[0]!.type).toBe("string");
  });
  it("examples (distinct, non-empty, at most 3) and the empty share", () => {
    expect(p[6]).toMatchObject({ name: "note", examples: ["a"], emptyPct: 50 });
    expect(p[0]!.examples).toHaveLength(3);
    expect(p[0]!.emptyPct).toBe(0);
  });
  it("uses at most 200 rows", () => {
    const many = Array.from({ length: 500 }, (_, i) => [i < 200 ? "1" : "x"]);
    expect(profile(["a"], many)[0]!.type).toBe("integer");
  });
  it("an all-empty column is a string, 100% empty", () => {
    expect(profile(["a"], [[""], [""]])[0]).toMatchObject({ type: "string", emptyPct: 100, examples: [] });
  });
});
