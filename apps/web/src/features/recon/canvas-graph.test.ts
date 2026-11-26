import { describe, expect, it } from "vitest";
import type { ReconSpec } from "@starterkit/shared/contracts/recon";
import { dropIndex, LANES, laneLayout, NODE_H, pipelineFits, ROW_GAP, specGraph } from "./canvas-graph";

const ccy = { op: "eq" as const, field: "currency" };
const side = (key: "a" | "b", label: string) => ({ key, label, source_id: "s", filter: [], amount_sign: "as_is" as const });
const spec: ReconSpec = {
  sides: [side("a", "source1"), side("b", "source2")],
  passes: [
    { no: 1, name: "Exact", cardinality: "1:1", blocking: ["ext_ref"], accept: "auto", on_ambiguous: "break", predicates: [{ op: "eq", field: "ext_ref" }, ccy] },
    { no: 2, name: "Amount within 1,000", cardinality: "1:1", blocking: ["ext_ref"], accept: "suggest", on_ambiguous: "break", predicates: [{ op: "amount_abs_tol", field: "amount_minor", tolerance: { IDR: "1000.00" } }, ccy] },
    { no: 3, name: "Date within 1 day", cardinality: "1:1", blocking: ["ext_ref"], accept: "suggest", on_ambiguous: "break", predicates: [{ op: "date_window", field: "business_date", days: 1 }, ccy] },
  ],
  carry_over_days: 1, schedule: { business_date_offset: 1, from: "07:00", to: "16:00", every_minutes: 60 },
} as ReconSpec;
const keys = ["p0", "p1", "p2"];

describe("builder canvas graph (DEC-041: locked lanes, fixed columns)", () => {
  it("sources, sides, passes in run order and their outcomes; a side or a pass opens the inspector", () => {
    const g = specGraph(spec, keys);
    const lane = (l: number) => g.nodes.filter((n) => n.lane === l).map((n) => n.title);
    expect(lane(0)).toEqual(["source1", "source2"]);
    expect(lane(1)).toEqual(["Side A · source1", "Side B · source2"]);
    expect(lane(2)).toEqual(["1. Exact", "2. Amount within 1,000", "3. Date within 1 day"]);
    expect(lane(3)).toEqual(["Matched", "Suggested", "Duplicate", "Unmatch"]);
    expect(g.nodes.find((n) => n.id === "p1")!.select).toEqual({ k: "pass", key: "p1" });
    expect(g.nodes.find((n) => n.id === "side-b")!.select).toEqual({ k: "side", i: 1 });
    expect(g.nodes.find((n) => n.id === "src-a")!.select).toBeNull();
    // a pass to the next one runs down the lane; no count without a simulation
    expect(g.edges.filter((e) => e.inLane).map((e) => `${e.source}>${e.target}`)).toEqual(["p0>p1", "p1>p2"]);
    expect(g.edges.every((e) => e.label === null)).toBe(true);
  });
  it("one column per lane, lanes left to right, passes top to bottom; a drop lands on the nearest slot", () => {
    const g = specGraph(spec, keys);
    const pos = laneLayout(g);
    const xs = LANES.map((_, l) => new Set(g.nodes.filter((n) => n.lane === l).map((n) => pos.get(n.id)!.x)));
    expect(xs.every((s) => s.size === 1)).toBe(true);
    const col = xs.map((s) => [...s][0]!);
    expect(col).toEqual([...col].sort((a, b) => a - b));
    const ys = keys.map((k) => pos.get(k)!.y);
    expect(ys).toEqual([...ys].sort((a, b) => a - b));
    expect(dropIndex(g, pos, ys[0]! - 500)).toBe(0);
    expect(dropIndex(g, pos, ys[1]! + (NODE_H + ROW_GAP) * 0.4)).toBe(1);
    expect(dropIndex(g, pos, ys[2]! + 900)).toBe(2);
  });
  it("with a simulation, counts on the edges (the same words as the list)", () => {
    const per = (n: number) => ({ a: n, b: n });
    const counters = { intake: per(1000), replaced: per(0), open: per(24), passes: {
      1: { matched: 937, suggested: 0, broken: 30, brokenRefs: 10, matchedItems: per(937), suggestedItems: per(0), brokenItems: per(15) },
      2: { matched: 0, suggested: 14, broken: 0, brokenRefs: 0, matchedItems: per(0), suggestedItems: per(14), brokenItems: per(0) },
      3: { matched: 0, suggested: 10, broken: 0, brokenRefs: 0, matchedItems: per(0), suggestedItems: per(10), brokenItems: per(0) },
    } };
    const g = specGraph(spec, keys, counters);
    expect(g.edges.find((e) => e.id === "e-p0-Matched")!.label).toContain("937");
    // per-side counts in the node lines, never on an edge (a long label would run over a node)
    expect(g.nodes.find((n) => n.id === "side-a")!.line).toBe("All records · 1,000 in");
    expect(g.nodes.find((n) => n.id === "out-unmatched")!.line).toBe("24 source1 · 24 source2; unmatch after a run");
    expect(g.edges.filter((e) => e.label).every((e) => e.label!.length <= 24)).toBe(true);
  });
});

describe("the live day's pipeline or its list (audit R6)", () => {
  it("the canvas only where it fits its card at 0.85 or more; narrower, the list", () => {
    // four lanes of 256 px with three 120 px gaps = 1,384 px, plus the fit's 32 px each side
    expect(pipelineFits(1241)).toBe(true); // 1,384 × 0.85 + 64 = 1,240.4
    expect(pipelineFits(1240)).toBe(false);
    expect(pipelineFits(1040)).toBe(false);
    expect(pipelineFits(0)).toBe(false);
  });
});
