"use client";

// The builder canvas (DEC-041, REC-S6 verdict "go with changes"): React Flow over fixed lanes (canvas-graph.ts, no
// ELK), the same data and actions as the list: choosing a side or a pass opens it in the inspector, a pass moves by
// drag (up and down its lane only) or Alt+↑/↓, and the simulation's counts sit on the edges, dimmed while the draft
// differs from what was simulated. Loaded on demand (canvas-loader.tsx); never on a phone (the list is, DEC-041).
import { type Accent, arrowOf, Controls, EDGE_TYPES, type Edge, type EdgeTone, FIT, FlowBadge, FlowBoard, FlowCard, type FlowEdgeData, Handle, LaneTitle, type Node, type NodeChangeset, type NodeProps, pathOf, PortHandles, ports, portsOf, Position, ReactFlow, ReactFlowProvider, ResetLayout, useFitToCard, useHotNode, ViewportPortal } from "@starterkit/ui/flow";
import { type KeyboardEvent, useCallback, useMemo, useRef, useState } from "react";
import type { ReconRunDto, ReconSpec } from "@starterkit/shared/contracts/recon";
import { DiskIcon, FilterIcon, SuccessIcon, SuggestedIcon, TimeIcon, WarningIcon } from "@starterkit/ui/ui/icons";
import { dropIndex, type GNode, LANES, laneLayout, NODE_H, NODE_W, specGraph } from "./canvas-graph";


type Data = {
  title: string; line: string; lane: number; tone: "matched" | "suggested" | "break" | "waiting" | null; badge?: GNode["badge"]; interactive: boolean; running: boolean;
  /** Its edges' ports (flow-parts.tsx ports). */
  ins?: [string, number][]; outs?: [string, number][];
};
export type CanvasProps = {
  spec: ReconSpec; keys: readonly string[]; counters?: ReconRunDto["counters"]; dim: boolean;
  /** The node open in the inspector: "side-a", "side-b" or a pass key. */
  selectedId: string | null; editable: boolean;
  /** Choosing a side or a pass; none on a read-only canvas (Live day), whose nodes then choose nothing. */
  onSelect?: (s: NonNullable<GNode["select"]>) => void;
  /** A pass moved from `from` to `to` (0-based); `byKey` when the keyboard moved it (the builder announces and refocuses). */
  onMove?: (from: number, to: number, byKey: boolean) => void;
  /** The source nodes' second lines (Live day: health and lag). */
  sourceLines?: readonly [string, string];
  /** Its accessible name (the builder's by default). */
  label?: string;
  /** A run is under way (Live day): packets travel every edge and the passes sweep (reduced motion: still, the stroke primary). */
  running?: boolean;
  /** New records just came in on side A / B (useArrivals): its source and side sweep, packets travel into the passes. */
  arriving?: readonly [boolean, boolean];
};

const TONE: Record<NonNullable<Data["tone"]>, { accent: Accent; icon: typeof SuccessIcon }> = {
  matched: { accent: "healthy", icon: SuccessIcon }, suggested: { accent: "primary", icon: SuggestedIcon },
  break: { accent: "degraded", icon: WarningIcon }, waiting: { accent: "stopped", icon: TimeIcon },
};
const toneOf = (n: GNode): Data["tone"] => (n.lane !== 3 ? null : n.title === "Matched" ? "matched" : n.title === "Suggested" ? "suggested" : n.id === "out-unmatched" ? "waiting" : "break");

function LaneNode({ data, selected }: NodeProps<Node<Data>>) {
  const step = data.lane === 2 ? /^(\d+)\. (.*)$/.exec(data.title) : null;
  const t = data.tone ? TONE[data.tone] : null;
  return (
    <>
      <PortHandles ins={data.ins ?? []} outs={data.outs ?? []} />
      <FlowCard step={step ? Number(step[1]) : undefined} title={step ? step[2]! : data.title} line={data.line} selected={selected} interactive={data.interactive} running={data.running}
        icon={t?.icon ?? (data.lane === 0 ? DiskIcon : data.lane === 1 ? FilterIcon : undefined)} accent={t?.accent ?? null}
        badge={data.badge ? <FlowBadge tone={data.badge === "Auto" ? "primary" : "neutral"}>{data.badge}</FlowBadge> : undefined} />
      {data.lane === 2 && <><Handle id="top" type="target" position={Position.Top} isConnectable={false} /><Handle id="bottom" type="source" position={Position.Bottom} isConnectable={false} /></>}
    </>
  );
}
const NODE_TYPES = { lane: LaneNode };
/** An edge into an outcome takes the outcome's colour; the rest of the flow stays plain. */
const edgeTone = (target: string): EdgeTone =>
  !target.startsWith("out-") ? null : target === "out-Matched" ? "matched" : target === "out-Suggested" ? "suggested" : target === "out-unmatched" ? "waiting" : "break";
const FAR = 1e6;

function Canvas({ spec, keys, counters, dim, selectedId, editable, onSelect, onMove, sourceLines, label, running, arriving }: CanvasProps) {
  const inflow = (id: string) => (arriving?.[0] && (id === "src-a" || id === "side-a")) || (arriving?.[1] && (id === "src-b" || id === "side-b"));
  const graph = useMemo(() => specGraph(spec, keys, counters, sourceLines), [spec, keys, counters, sourceLines]);
  const pos = useMemo(() => laneLayout(graph), [graph]);
  // the builder: a pass moves up and down its lane (its order); read-only (Live day): every card moves freely, as on a
  // whiteboard, until Reset layout
  const drag = editable && spec.passes.length > 1;
  const free = !editable;
  const place = useCallback((): Node<Data>[] => graph.nodes.map((n) => {
    const p = pos.get(n.id)!;
    return {
      id: n.id, type: "lane", position: p, width: NODE_W, height: NODE_H, selected: n.id === selectedId,
      data: { title: n.title, line: n.line, lane: n.lane, tone: toneOf(n), badge: n.badge, interactive: !!(onSelect && n.select), running: (!!running && n.lane === 2) || !!inflow(n.id) },
      // a pass moves up and down its lane only: its x is pinned (REC-S6: 0 px sideways at 240 px of pointer)
      draggable: free || (drag && n.lane === 2), ...(free ? {} : { extent: [[p.x, -FAR], [p.x + NODE_W, FAR]] as [[number, number], [number, number]] }),
      ariaLabel: `${LANES[n.lane]}: ${n.title}. ${n.line}${n.lane === 2 && editable ? ". Alt+Up or Alt+Down moves it" : ""}`,
    };
  }), [graph, pos, selectedId, drag, editable, onSelect, running, arriving]); // eslint-disable-line react-hooks/exhaustive-deps -- inflow follows arriving
  const [nodes, setNodes] = useState<Node<Data>[]>(place);
  // a new graph (a pass moved, renamed, a simulation) or selection: every node back in its lane slot (set while
  // rendering, React's pattern for state that follows a prop)
  const [placedBy, setPlacedBy] = useState(() => place);
  // its shape (which cards, which edges): counts and lines change on every live tick, the shape doesn't
  const shape = graph.nodes.map((n) => n.id).join("|") + "/" + graph.edges.map((e) => e.id).join("|");
  const [placedShape, setPlacedShape] = useState(shape);
  if (placedBy !== place) {
    setPlacedBy(() => place);
    setPlacedShape(shape);
    // read-only and the same graph (a live tick, a hover): cards keep where they were dragged
    const kept = free && placedShape === shape ? new Map(nodes.map((n) => [n.id, n.position])) : null;
    setNodes(place().map((n) => (kept?.has(n.id) ? { ...n, position: kept.get(n.id)! } : n)));
  }
  const wrap = useRef<HTMLDivElement>(null);
  // always fits its card: on load, when passes are added, removed or renamed, when the card resizes
  useFitToCard(wrap, `${graph.nodes.length}:${graph.edges.length}`);

  const hover = useHotNode();
  const lit = useMemo(() => pathOf(hover.hot, graph.edges), [hover.hot, graph.edges]);
  // a port per edge, ordered by where the other end sits now (a dragged card re-orders them)
  const ys = useMemo(() => new Map(nodes.map((n) => [n.id, n.position.y])), [nodes]);
  const port = useMemo(() => ports(graph.edges, (id) => ys.get(id) ?? 0, (id) => !!graph.edges.find((e) => e.id === id)?.inLane), [graph, ys]);
  const edges: Edge<FlowEdgeData>[] = useMemo(() => graph.edges.map((e) => {
    const live = !!running || !!inflow(e.source);
    const tone = edgeTone(e.target);
    return {
      id: e.id, source: e.source, target: e.target, type: "flow", focusable: false,
      data: { live, kind: e.inLane ? "step" : undefined, tone, text: e.label ?? undefined, quiet: dim || /^0\b/.test(e.label ?? "") },
      sourceHandle: e.inLane ? "bottom" : `o-${e.id}`, targetHandle: e.inLane ? "top" : `i-${e.id}`,
      markerEnd: arrowOf(tone, live),
      className: [live && "is-live", lit && (lit.edges.has(e.id) ? "is-lit" : "is-dim")].filter(Boolean).join(" ") || undefined,
    };
  }), [graph, dim, running, lit, arriving]); // eslint-disable-line react-hooks/exhaustive-deps -- inflow follows arriving
  const shown = useMemo(() => nodes.map((n) => ({
    ...n, data: { ...n.data, ...portsOf(n.id, graph.edges, port) }, className: lit && !lit.nodes.has(n.id) ? "is-dim" : undefined,
  })), [nodes, lit, graph, port]);

  const passIds = graph.nodes.filter((n) => n.lane === 2).map((n) => n.id);
  const focusNode = (id: string | undefined) => { if (id) wrap.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`)?.focus(); };
  /** Alt+↑/↓ moves a pass (as the list); ↑/↓ moves the focus in a lane, ←/→ to the nearest node of the next lane; Enter opens it. */
  const onKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    const id = (e.target as HTMLElement).closest(".react-flow__node")?.getAttribute("data-id");
    const node = graph.nodes.find((n) => n.id === id);
    if (!node) return;
    if (e.key === "Enter" || e.key === " ") {
      if (node.select && onSelect) { e.preventDefault(); onSelect(node.select); }
      return;
    }
    if (!e.key.startsWith("Arrow")) return;
    e.preventDefault();
    e.stopPropagation(); // React Flow would nudge the selected node 5 px: no meaning in a locked lane
    if (e.altKey && node.lane === 2 && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      if (!editable || !onMove) return;
      const from = passIds.indexOf(node.id), to = from + (e.key === "ArrowUp" ? -1 : 1);
      if (to >= 0 && to < passIds.length) onMove(from, to, true);
      return;
    }
    const inLane = (l: number) => graph.nodes.filter((n) => n.lane === l);
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const col = inLane(node.lane), i = col.indexOf(node);
      return focusNode(col[i + (e.key === "ArrowUp" ? -1 : 1)]?.id);
    }
    const y = pos.get(node.id)!.y;
    const col = inLane(node.lane + (e.key === "ArrowLeft" ? -1 : 1));
    focusNode(col.reduce<GNode | undefined>((best, n) => (!best || Math.abs(pos.get(n.id)!.y - y) < Math.abs(pos.get(best.id)!.y - y) ? n : best), undefined)?.id);
  };

  const onNodesChange = useCallback((c: NodeChangeset<Node<Data>>) => setNodes((ns) => c.applyTo(ns)), []); // v13: a changeset
  /** A drop in the Passes lane takes the slot nearest its middle; anywhere else it goes back to its slot. */
  const onNodeDragStop = useCallback((_: unknown, n: Node<Data>) => {
    if (free) return; // read-only: the card stays where it was dropped
    const from = passIds.indexOf(n.id), to = dropIndex(graph, pos, n.position.y);
    if (from < 0 || from === to || !onMove) { setNodes(place()); return; }
    onMove(from, to, false);
  }, [free, passIds, graph, pos, place, onMove]);

  const tallest = Math.max(...LANES.map((_, l) => graph.nodes.filter((n) => n.lane === l).length));
  // as tall as its tallest lane, within a screen
  const height = Math.min(720, Math.max(360, tallest * (NODE_H + 24) + 140));
  const laneX = LANES.map((_, l) => pos.get(graph.nodes.find((n) => n.lane === l)?.id ?? "")?.x);
  return (
    <div ref={wrap} className="flow-canvas" style={{ height }} onKeyDownCapture={onKeyDownCapture} onFocusCapture={hover.onFocusCapture} onBlurCapture={hover.onBlurCapture}>
      <ReactFlow nodes={shown} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES} onNodeMouseEnter={hover.onNodeMouseEnter} onNodeMouseLeave={hover.onNodeMouseLeave} onNodesChange={onNodesChange} onNodeDragStop={onNodeDragStop}
        onNodeClick={(_, n) => { const g = graph.nodes.find((x) => x.id === n.id); if (g?.select && onSelect) onSelect(g.select); }}
        nodesConnectable={false} edgesFocusable={false} elementsSelectable={false} fitView fitViewOptions={FIT} minZoom={0.25} maxZoom={1.5}
        proOptions={{ hideAttribution: true }} aria-label={label ?? "Passes as a canvas: sources, sides, passes in run order and their outcomes"}>
        <FlowBoard />
        <Controls showInteractive={false}>{free && <ResetLayout onReset={() => setNodes(place())} />}</Controls>
        <ViewportPortal>
          {laneX.map((x, l) => x !== undefined && <LaneTitle key={l} x={x} label={LANES[l]!} count={graph.nodes.filter((n) => n.lane === l).length} />)}
        </ViewportPortal>
      </ReactFlow>
    </div>
  );
}

export function ReconCanvas(p: CanvasProps) {
  return <ReactFlowProvider><Canvas {...p} /></ReactFlowProvider>;
}
