import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ReconRunDto, ReconSpec } from "@starterkit/shared/contracts/recon";
import { LastRun } from "./run-summary";

// The gate run on :3000 (08:06 WIB): no new intake, its four dates closed; what stands now over 2–5 Nov.
const spec = { sides: [{ label: "src1 r2" }, { label: "src2 r2b" }], passes: [{ no: 1, blocking: ["ext_ref"], predicates: [{ op: "eq" }], cardinality: "1:1", accept: "auto" }] } as unknown as ReconSpec;
const day = (date: string, matched: number, dup: number, rest: number) => ({
  date, closed: true, open: { a: 0, b: 0 }, breaks: { a: rest, b: rest }, items: { a: 333, b: 333 },
  passes: { 1: { matched, suggested: 0, broken: dup * 2, brokenRefs: 1 } }, breakReasons: { Duplicate: { a: dup, b: dup }, "No counterpart": { a: rest, b: rest } },
});
const gate = {
  id: "0199f0a0-0000-7000-8000-00000000000d", configId: "c", versionId: "v", version: 1, specHash: "h", mode: "manual", status: "succeeded",
  from: "2026-11-02", to: "2026-11-05", doneThrough: "2026-11-05", error: null,
  startedAt: "2026-11-21T01:05:00Z", finishedAt: "2026-11-21T01:06:00Z", baseline: null, changes: null, projection: null,
  counters: { intake: { a: 0, b: 0 }, replaced: { a: 0, b: 0 }, open: { a: 0, b: 0 }, passes: { 1: { matched: 0, suggested: 0, broken: 0 } } },
  // a carry-over date before the run's own dates: not on the Overview
  days: [day("2026-11-01", 0, 0, 1), day("2026-11-02", 312, 6, 15), day("2026-11-03", 313, 5, 16), day("2026-11-04", 312, 4, 17), day("2026-11-05", 0, 0, 4)],
  live: { matched: 937, suggested: 0, breaks: { a: 48, b: 48 }, open: { a: 0, b: 0 }, items: { a: 1000, b: 1000 }, breakReasons: { Duplicate: { a: 15, b: 15 }, "No counterpart": { a: 48, b: 48 } } },
} as unknown as ReconRunDto;
const render = (run: ReconRunDto, newer: ReconRunDto | null = null) =>
  renderToStaticMarkup(h(LastRun, { spaceId: "s", id: "r", run, newer, spec, labels: ["src1 r2", "src2 r2b"] }));

describe("the Overview's headline run (R6-1)", () => {
  it("titled by its dates and time, the run page's line under it, never \"no new records\"", () => {
    const html = render(gate);
    expect(html).toContain("Run 2–5 Nov · 08:06 WIB");
    expect(html).toContain("937 matched · 63 breaks per side (15 duplicate per side) · match rate 93.7%");
    expect(html).not.toContain("no new records");
  });

  it("its date strip: All dates and its four own dates, each opening that date of the run; no carry-over tile", () => {
    const html = render(gate);
    const dates = [...html.matchAll(/href="\/spaces\/s\/recons\/r\/runs\/[^"?]+\?date=([\d-]+)"/g)].map((m) => m[1]);
    expect(dates).toEqual(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"]);
  });

  it("a newer run without records is the small line only", () => {
    const empty = { ...gate, id: "0199f0a0-0000-7000-8000-00000000000e", startedAt: "2026-11-21T01:55:00Z", finishedAt: "2026-11-21T01:55:30Z" } as ReconRunDto;
    const html = render(gate, empty);
    expect(html).toContain("Run 2–5 Nov · 08:06 WIB");
    expect(html).toContain("Last run 08:55 · no new records");
  });
});
