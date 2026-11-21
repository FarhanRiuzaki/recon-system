// The builder canvas as a graph (DEC-041, REC-S6 verdict): locked lanes Sources → Sides → Passes → Outcomes, laid out
// in fixed columns without ELK (the lane options ELK needed switched its crossing minimisation off, so a column per lane
// stacked in order is the same layout at none of the 450 kB). Pure: the canvas and its tests share it.
import type { ReconRunDto, ReconSpec } from "@starterkit/shared/contracts/recon";
import { formatNumber } from "@starterkit/ui/lib/format";
import { breakLabel, passOutcome, runTotals } from "./run-model";

export const LANES = ["Sources", "Sides", "Passes", "Outcomes"] as const;
export type Lane = 0 | 1 | 2 | 3;
/** `select`: what choosing the node opens in the inspector (a side, a pass by its key), or nothing (a source, an outcome). */
export type GNode = { id: string; lane: Lane; title: string; line: string; select: { k: "side"; i: 0 | 1 } | { k: "pass"; key: string } | null };
/**
 * `inLane`: a pass to the next pass, drawn down the Passes lane. `label`: the simulation's count on it, short (a pass's
 * pairs or items); the per-side counts sit in the node lines, so a label never runs over a node.
 */
export type GEdge = { id: string; source: string; target: string; label: string | null; inLane?: true };
export type LaneGraph = { nodes: GNode[]; edges: GEdge[] };
type Counters = ReconRunDto["counters"];

export const NODE_W = 216;
export const NODE_H = 64;
/** Between two lanes (room for a short edge label) and between two nodes of a lane. */
export const LANE_GAP = 120;
export const ROW_GAP = 24;

/**
 * The builder canvas of `spec`: pass ids from `keys` (stable across a reorder, as the builder keeps them); counts on the
 * edges with `counters`. `sourceLines`: the source nodes' second lines (Live day: each source's health and lag).
 */
export function specGraph(spec: ReconSpec, keys: readonly string[], counters?: Counters, sourceLines?: readonly [string, string]): LaneGraph {
  const [a, b] = spec.sides;
  const t = counters ? runTotals(counters, spec) : null;
  const sideLine = (n: number, inCount?: number) =>
    `${n ? `${n} ${n === 1 ? "filter" : "filters"}` : "All records"}${inCount !== undefined ? ` · ${formatNumber(inCount)} in` : ""}`;
  const nodes: GNode[] = [
    { id: "src-a", lane: 0, title: a.label, line: sourceLines?.[0] ?? "Source of side A", select: null },
    { id: "src-b", lane: 0, title: b.label, line: sourceLines?.[1] ?? "Source of side B", select: null },
    { id: "side-a", lane: 1, title: `Side A · ${a.label}`, line: sideLine(a.filter.length, t?.in.a), select: { k: "side", i: 0 } },
    { id: "side-b", lane: 1, title: `Side B · ${b.label}`, line: sideLine(b.filter.length, t?.in.b), select: { k: "side", i: 1 } },
  ];
  const edges: GEdge[] = [{ id: "e-src-a", source: "src-a", target: "side-a", label: null }, { id: "e-src-b", source: "src-b", target: "side-b", label: null }];
  const outs = new Map<string, string>();
  spec.passes.forEach((p, i) => {
    const id = keys[i]!;
    nodes.push({ id, lane: 2, title: `${i + 1}. ${p.name || "Untitled pass"}`, line: `${p.cardinality} · ${p.accept === "auto" ? "Matches" : "Suggests"} · ${p.predicates.length} ${p.predicates.length === 1 ? "condition" : "conditions"}`, select: { k: "pass", key: id } });
    if (i === 0) edges.push({ id: `e-a-${id}`, source: "side-a", target: id, label: null }, { id: `e-b-${id}`, source: "side-b", target: id, label: null });
    else edges.push({ id: `e-${keys[i - 1]}-${id}`, source: keys[i - 1]!, target: id, label: null, inLane: true });
    // where a pass's items go: matched, suggested or its break; with counters, how many
    const tags = counters ? passOutcome(counters, spec, p) : [{ tag: p.accept === "auto" ? "Matched" : "Suggested", count: null }, { tag: breakLabel(p), count: null }];
    for (const o of tags) {
      const out = o.tag === "Matched" || o.tag === "Suggested" ? o.tag : breakLabel(p);
      outs.set(out, `out-${out}`);
      edges.push({ id: `e-${id}-${out}`, source: id, target: `out-${out}`, label: o.count ?? null });
    }
  });
  const ORDER = ["Matched", "Suggested"];
  const sorted = [...outs].sort(([x], [y]) => (ORDER.indexOf(x) < 0 ? 9 : ORDER.indexOf(x)) - (ORDER.indexOf(y) < 0 ? 9 : ORDER.indexOf(y)));
  for (const [out, id] of sorted) nodes.push({ id, lane: 3, title: out, line: out === "Matched" ? "Closed" : out === "Suggested" ? "Open until accepted" : "A break to review", select: null });
  if (spec.passes.length) {
    const open = counters ? `${formatNumber(counters.open.a)} ${a.label} · ${formatNumber(counters.open.b)} ${b.label}` : "No counterpart yet";
    nodes.push({ id: "out-unmatched", lane: 3, title: "Waiting", line: `${open}; a break at day close`, select: null });
    edges.push({ id: "e-last-unmatched", source: keys[spec.passes.length - 1]!, target: "out-unmatched", label: null });
  }
  return { nodes, edges };
}

/**
 * Fixed lanes: a column per lane, its nodes stacked in order, each lane centred on the tallest one, so the Passes lane
 * reads top to bottom in run order and nothing can cross into another lane.
 */
export function laneLayout(g: LaneGraph): Map<string, { x: number; y: number }> {
  const per = LANES.map((_, l) => g.nodes.filter((n) => n.lane === l));
  const height = (n: number) => (n ? n * NODE_H + (n - 1) * ROW_GAP : 0);
  const tallest = Math.max(...per.map((ns) => height(ns.length)));
  const pos = new Map<string, { x: number; y: number }>();
  per.forEach((ns, l) => {
    const top = (tallest - height(ns.length)) / 2;
    ns.forEach((n, i) => pos.set(n.id, { x: l * (NODE_W + LANE_GAP), y: top + i * (NODE_H + ROW_GAP) }));
  });
  return pos;
}

/** The pass a drop at height `y` lands on: the Passes lane's slots, top to bottom (0-based), clamped to the passes. */
export function dropIndex(g: LaneGraph, pos: ReadonlyMap<string, { x: number; y: number }>, y: number): number {
  const passes = g.nodes.filter((n) => n.lane === 2);
  if (!passes.length) return 0;
  const top = pos.get(passes[0]!.id)!.y;
  return Math.max(0, Math.min(passes.length - 1, Math.round((y - top) / (NODE_H + ROW_GAP))));
}
