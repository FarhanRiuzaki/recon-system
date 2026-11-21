"use client";

// The Space map (DEC-041, spec §11a, REC-F4): sources → recons of the space, read-only. A source's health and lag on
// its node, a recon's day, waiting and open breaks on its; an edge per side, as thick as the source's records today; a
// recon reading a Degraded or Down source is marked (border and its line say which). A recon opens its Live day (click
// or Enter); arrows move the focus in and across the two lanes; a recon whose run is under way says Running and its
// edges flow. Always fits its card (flow-parts.tsx). Loaded on demand (today-page.tsx).
import { Controls, Handle, type Edge, type Node, type NodeProps, Position, ReactFlow, ReactFlowProvider, ViewportPortal } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import "./recon-canvas.css";
import { useRouter } from "next/navigation";
import { type KeyboardEvent, useMemo, useRef } from "react";
import { StatusChip } from "@starterkit/ui/ds";
import { formatNumber } from "@starterkit/ui/lib/format";
import { Icon } from "@starterkit/ui/ui/icon";
import { BranchIcon, SpinnerIcon } from "@starterkit/ui/ui/icons";
import { type Accent, EDGE_TYPES, sourceKindIcon, FIT, FlowBadge, FlowBoard, FlowCard, type FlowEdgeData, LaneTitle, pathOf, useElapsed, useFitToCard, useHotNode } from "./flow-parts";
import type { MapEdge, MapNode } from "./live-model";

const W = 280, H = 68, GAP_X = 180, GAP_Y = 20;
const LANES = ["Sources", "Recons"] as const;
type Data = Omit<MapNode, "id">;

const ACCENT: Record<MapNode["chip"]["health"], Accent> = { healthy: null, degraded: "degraded", down: "down", stopped: null, unknown: null };

function MapCard({ data }: NodeProps<Node<Data>>) {
  const hit = !!data.affectedBy?.length;
  const elapsed = useElapsed(data.running === "running" ? data.runStartedAt : null);
  return (
    <>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <FlowCard icon={data.lane === 0 ? sourceKindIcon(data.kind ?? "db_watermark") : data.running === "running" ? SpinnerIcon : BranchIcon} title={data.title} accent={ACCENT[data.chip.health]} marked={hit}
        interactive={!!data.href} running={data.running === "running" || !!data.arriving}
        line={elapsed ? `Running for ${elapsed}` : data.arriving ? `+${formatNumber(data.arriving)} records just in` : hit ? `Reads ${data.affectedBy!.join(", ")}` : data.line}
        badge={data.running
          ? <FlowBadge tone="primary"><Icon icon={SpinnerIcon} size={12} className={data.running === "running" ? "motion-safe:animate-spin" : undefined} />{data.running === "running" ? "Running" : "Queued"}</FlowBadge>
          : <StatusChip health={data.chip.health} label={data.chip.label} />} />
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </>
  );
}
const NODE_TYPES = { card: MapCard };

/** A column per lane, each centred on the taller one. */
function layout(nodes: readonly MapNode[]) {
  const per = LANES.map((_, l) => nodes.filter((n) => n.lane === l));
  const h = (n: number) => (n ? n * H + (n - 1) * GAP_Y : 0);
  const tall = Math.max(...per.map((ns) => h(ns.length)));
  const pos = new Map<string, { x: number; y: number }>();
  per.forEach((ns, l) => ns.forEach((n, i) => pos.set(n.id, { x: l * (W + GAP_X), y: (tall - h(ns.length)) / 2 + i * (H + GAP_Y) })));
  return { pos, tall };
}

function MapCanvas({ nodes: input, edges: links }: { nodes: MapNode[]; edges: MapEdge[] }) {
  const router = useRouter();
  const wrap = useRef<HTMLDivElement>(null);
  const { pos, tall } = useMemo(() => layout(input), [input]);
  const hover = useHotNode();
  const lit = useMemo(() => pathOf(hover.hot, links), [hover.hot, links]);
  const nodes: Node<Data>[] = useMemo(() => input.map(({ id, ...data }) => ({
    id, type: "card", className: lit && !lit.nodes.has(id) ? "is-dim" : undefined, position: pos.get(id)!, width: W, height: H, data, draggable: false, selectable: false,
    ariaLabel: `${LANES[data.lane]}: ${data.title}. ${data.chip.label}. ${data.affectedBy?.length ? `Reads ${data.affectedBy.join(", ")}` : data.line}${data.href ? ". Enter opens its live day" : ""}`,
  })), [input, pos, lit]);
  // packets travel from each source into a recon whose run is under way
  const edges: Edge<FlowEdgeData>[] = useMemo(() => links.map((e) => ({
    id: e.id, source: e.source, target: e.target, focusable: false, type: "flow", data: { live: e.live }, style: { strokeWidth: e.width },
    className: [e.live && "is-live", lit && (lit.edges.has(e.id) ? "is-lit" : "is-dim")].filter(Boolean).join(" ") || undefined,
  })), [links, lit]);
  useFitToCard(wrap, `${input.length}:${links.length}`);
  const focus = (id: string | undefined) => { if (id) wrap.current?.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(id)}"]`)?.focus(); };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const id = (e.target as HTMLElement).closest(".react-flow__node")?.getAttribute("data-id");
    const n = input.find((x) => x.id === id);
    if (!n) return;
    if (e.key === "Enter" && n.href) { e.preventDefault(); router.push(n.href); return; }
    if (!e.key.startsWith("Arrow")) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const col = input.filter((x) => x.lane === n.lane);
      return focus(col[col.indexOf(n) + (e.key === "ArrowUp" ? -1 : 1)]?.id);
    }
    const y = pos.get(n.id)!.y, col = input.filter((x) => x.lane === (e.key === "ArrowLeft" ? 0 : 1));
    focus(col.reduce<MapNode | undefined>((b, x) => (!b || Math.abs(pos.get(x.id)!.y - y) < Math.abs(pos.get(b.id)!.y - y) ? x : b), undefined)?.id);
  };
  return (
    <div ref={wrap} className="recon-canvas" style={{ height: Math.min(640, Math.max(320, tall + 120)) }} onKeyDownCapture={onKey} onFocusCapture={hover.onFocusCapture} onBlurCapture={hover.onBlurCapture}>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES} onNodeMouseEnter={hover.onNodeMouseEnter} onNodeMouseLeave={hover.onNodeMouseLeave} nodesConnectable={false} nodesDraggable={false} elementsSelectable={false} edgesFocusable={false}
        onNodeClick={(_, n) => { const h = input.find((x) => x.id === n.id)?.href; if (h) router.push(h); }}
        fitView fitViewOptions={FIT} minZoom={0.3} maxZoom={1.5} proOptions={{ hideAttribution: true }}
        aria-label="Space map: the sources of the space and the recons that read them">
        <FlowBoard />
        <Controls showInteractive={false} />
        <ViewportPortal>
          {LANES.map((name, l) => <LaneTitle key={name} x={l * (W + GAP_X)} label={name} count={input.filter((n) => n.lane === l).length} />)}
        </ViewportPortal>
      </ReactFlow>
    </div>
  );
}

export function SpaceMap(p: { nodes: MapNode[]; edges: MapEdge[] }) {
  return <ReactFlowProvider><MapCanvas {...p} /></ReactFlowProvider>;
}
