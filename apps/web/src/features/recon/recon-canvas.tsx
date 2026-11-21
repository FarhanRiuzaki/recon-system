"use client";

// The builder canvas (DEC-041, REC-S6 verdict "go with changes"): React Flow over fixed lanes (canvas-graph.ts, no
// ELK), the same data and actions as the list: choosing a side or a pass opens it in the inspector, a pass moves by
// drag (up and down its lane only) or Alt+↑/↓, and the simulation's counts sit on the edges, dimmed while the draft
// differs from what was simulated. Loaded on demand (canvas-loader.tsx); never on a phone (the list is, DEC-041).
import { Controls, Handle, MarkerType, type Edge, type Node, type NodeChangeset, type NodeProps, Position, ReactFlow, ReactFlowProvider, ViewportPortal } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import "./recon-canvas.css";
import { type KeyboardEvent, useCallback, useMemo, useRef, useState } from "react";
import type { ReconRunDto, ReconSpec } from "@starterkit/shared/contracts/recon";
import { DiskIcon, FilterIcon, SuccessIcon, SuggestedIcon, TimeIcon, WarningIcon } from "@starterkit/ui/ui/icons";
import { dropIndex, type GNode, LANES, laneLayout, NODE_H, NODE_W, specGraph } from "./canvas-graph";
import { type Accent, EDGE_TYPES, FIT, FlowBadge, FlowBoard, FlowCard, type FlowEdgeData, LaneTitle, pathOf, useFitToCard, useHotNode } from "./flow-parts";

type Data = { title: string; line: string; lane: number; tone: "matched" | "suggested" | "break" | "waiting" | null; badge?: GNode["badge"]; interactive: boolean; running: boolean };
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
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <FlowCard step={step ? Number(step[1]) : undefined} title={step ? step[2]! : data.title} line={data.line} selected={selected} interactive={data.interactive} running={data.running}
        icon={t?.icon ?? (data.lane === 0 ? DiskIcon : data.lane === 1 ? FilterIcon : undefined)} accent={t?.accent ?? null}
        badge={data.badge ? <FlowBadge tone={data.badge === "Auto" ? "primary" : "neutral"}>{data.badge}</FlowBadge> : undefined} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
      {data.lane === 2 && <><Handle id="top" type="target" position={Position.Top} isConnectable={false} /><Handle id="bottom" type="source" position={Position.Bottom} isConnectable={false} /></>}
    </>
  );
}
const NODE_TYPES = { lane: LaneNode };
const FAR = 1e6;

function Canvas({ spec, keys, counters, dim, selectedId, editable, onSelect, onMove, sourceLines, label, running }: CanvasProps) {
  const graph = useMemo(() => specGraph(spec, keys, counters, sourceLines), [spec, keys, counters, sourceLines]);
  const pos = useMemo(() => laneLayout(graph), [graph]);
  const drag = editable && spec.passes.length > 1;
  const place = useCallback((): Node<Data>[] => graph.nodes.map((n) => {
    const p = pos.get(n.id)!;
    return {
      id: n.id, type: "lane", position: p, width: NODE_W, height: NODE_H, selected: n.id === selectedId,
      data: { title: n.title, line: n.line, lane: n.lane, tone: toneOf(n), badge: n.badge, interactive: !!(onSelect && n.select), running: !!running && n.lane === 2 },
      // a pass moves up and down its lane only: its x is pinned (REC-S6: 0 px sideways at 240 px of pointer)
      draggable: drag && n.lane === 2, extent: [[p.x, -FAR], [p.x + NODE_W, FAR]],
      ariaLabel: `${LANES[n.lane]}: ${n.title}. ${n.line}${n.lane === 2 && editable ? ". Alt+Up or Alt+Down moves it" : ""}`,
    };
  }), [graph, pos, selectedId, drag, editable, onSelect, running]);
  const [nodes, setNodes] = useState<Node<Data>[]>(place);
  // a new graph (a pass moved, renamed, a simulation) or selection: every node back in its lane slot (set while
  // rendering, React's pattern for state that follows a prop)
  const [placedBy, setPlacedBy] = useState(() => place);
  if (placedBy !== place) { setPlacedBy(() => place); setNodes(place()); }
  const wrap = useRef<HTMLDivElement>(null);
  // always fits its card: on load, when passes are added, removed or renamed, when the card resizes
  useFitToCard(wrap, `${graph.nodes.length}:${graph.edges.length}`);

  const hover = useHotNode();
  const lit = useMemo(() => pathOf(hover.hot, graph.edges), [hover.hot, graph.edges]);
  const edges: Edge<FlowEdgeData>[] = useMemo(() => graph.edges.map((e) => ({
    id: e.id, source: e.source, target: e.target, label: e.label ?? undefined, type: "flow", data: { live: !!running, kind: e.inLane ? "step" : undefined },
    sourceHandle: e.inLane ? "bottom" : undefined, targetHandle: e.inLane ? "top" : undefined, focusable: false,
    markerEnd: { type: MarkerType.ArrowClosed, color: running ? "var(--primary)" : "var(--fg-4)", width: 14, height: 14 },
    labelBgPadding: [8, 3] as [number, number], labelBgBorderRadius: 999,
    labelStyle: dim ? { opacity: 0.6 } : undefined,
    className: [running && "is-live", lit && (lit.edges.has(e.id) ? "is-lit" : "is-dim")].filter(Boolean).join(" ") || undefined,
  })), [graph, dim, running, lit]);
  const shown = useMemo(() => (lit ? nodes.map((n) => ({ ...n, className: lit.nodes.has(n.id) ? undefined : "is-dim" })) : nodes), [nodes, lit]);

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
    const from = passIds.indexOf(n.id), to = dropIndex(graph, pos, n.position.y);
    if (from < 0 || from === to || !onMove) { setNodes(place()); return; }
    onMove(from, to, false);
  }, [passIds, graph, pos, place, onMove]);

  const tallest = Math.max(...LANES.map((_, l) => graph.nodes.filter((n) => n.lane === l).length));
  // as tall as its tallest lane, within a screen
  const height = Math.min(720, Math.max(360, tallest * (NODE_H + 24) + 140));
  const laneX = LANES.map((_, l) => pos.get(graph.nodes.find((n) => n.lane === l)?.id ?? "")?.x);
  return (
    <div ref={wrap} className="recon-canvas" style={{ height }} onKeyDownCapture={onKeyDownCapture} onFocusCapture={hover.onFocusCapture} onBlurCapture={hover.onBlurCapture}>
      <ReactFlow nodes={shown} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES} onNodeMouseEnter={hover.onNodeMouseEnter} onNodeMouseLeave={hover.onNodeMouseLeave} onNodesChange={onNodesChange} onNodeDragStop={onNodeDragStop}
        onNodeClick={(_, n) => { const g = graph.nodes.find((x) => x.id === n.id); if (g?.select && onSelect) onSelect(g.select); }}
        nodesConnectable={false} edgesFocusable={false} elementsSelectable={false} fitView fitViewOptions={FIT} minZoom={0.25} maxZoom={1.5}
        proOptions={{ hideAttribution: true }} aria-label={label ?? "Passes as a canvas: sources, sides, passes in run order and their outcomes"}>
        <FlowBoard />
        <Controls showInteractive={false} />
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
