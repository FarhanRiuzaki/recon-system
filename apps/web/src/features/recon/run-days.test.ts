import { describe, expect, it } from "vitest";
import type { ReconRunDto, ReconSpec } from "@starterkit/shared/contracts/recon";
import { dayTilesOf, tileBreaks, tileOption } from "./run-days";

// The gate after day close: 2 Nov with its duplicates among the breaks (one definition), and a simulation's day.
const spec = { sides: [{ label: "src1 r2" }, { label: "src2 r2b" }], passes: [{ no: 1, blocking: ["ext_ref"], predicates: [{ op: "eq" }], cardinality: "1:1", accept: "auto" }] } as unknown as ReconSpec;
const L = ["src1 r2", "src2 r2b"] as const;
const day = {
  date: "2026-11-02", closed: true, open: { a: 0, b: 0 }, breaks: { a: 12, b: 13 },
  passes: { 1: { matched: 312, suggested: 0, broken: 12, brokenRefs: 4 } },
  breakReasons: { Duplicate: { a: 6, b: 6 }, "No counterpart": { a: 6, b: 7 }, "Amount differs": { a: 5, b: 5 }, "Date differs": { a: 3, b: 0 }, "Currency differs": { a: 1, b: 1 } },
};
const counters = { intake: { a: 1000, b: 1000 }, replaced: { a: 0, b: 0 }, open: { a: 0, b: 0 }, passes: { 1: { matched: 937, suggested: 0, broken: 30 } } };
const run = { mode: "manual", counters, days: [day], from: "2026-11-02", to: "2026-11-05",
  live: { matched: 937, suggested: 0, breaks: { a: 48, b: 48 }, open: { a: 0, b: 0 }, items: { a: 1000, b: 1000 }, breakReasons: { Duplicate: { a: 15, b: 15 }, "No counterpart": { a: 48, b: 48 } } } } as unknown as ReconRunDto;

describe("a run's date tiles: unmatch per side with the date's duplicates in them", () => {
  it("a real run's day: 21 · 19 breaks with 6 duplicate per side, marked closed; All dates by the run's line", () => {
    const [all, d2] = dayTilesOf(run, spec);
    expect(tileBreaks(d2!, L)).toBe("21 src1 r2 · 19 src2 r2b unmatch (6 duplicate per side)");
    expect(tileOption(d2!, L)).toBe("2 Nov · closed · 312 matched · 0 suggested · 21 src1 r2 · 19 src2 r2b unmatch (6 duplicate per side)");
    expect(tileBreaks(all!, L)).toBe("63 unmatch per side (15 duplicate per side)");
  });
  it("a simulation's day keeps its duplicates by their pass, not as breaks", () => {
    const [, d2] = dayTilesOf({ ...run, mode: "simulation" } as ReconRunDto, spec);
    expect(d2!.b).toBeNull();
    expect(tileBreaks(d2!, L)).toBe("12 src1 r2 · 13 src2 r2b unmatch");
  });
});
