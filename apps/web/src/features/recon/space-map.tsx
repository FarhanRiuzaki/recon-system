"use client";

// The Space map (DEC-041, spec §11a, REC-F4): sources → recons of the space, read-only. A source's health and lag on
// its node, a recon's day, waiting and open breaks on its; an edge per side, as thick as the source's records today; a
// recon reading a Degraded or Down source is marked (border and its line say which). A recon opens its Live day (click
// or Enter); arrows move the focus in and across the two lanes. Loaded on demand (space-map-loader.tsx).
import { Background, Controls, Handle, type Edge, type Node, type NodeProps, Position, ReactFlow, ReactFlowProvider, ViewportPortal } from "@xyflow/react";
import "@xyflow/react/dist/base.css";
import "./recon-canvas.css";
import { useRouter } from "next/navigation";
import { type KeyboardEvent, useMemo, useRef } from "react";
import { StatusChip } from "@starterkit/ui/ds";
import { cn } from "@starterkit/ui/lib/cn";
import type { MapEdge, MapNode } from "./live-model";

const W = 260, H = 76, GAP_X = 200, GAP_Y = 20;
const LANES = ["Sources", "Recons"] as const;
type Data = Omit<MapNode, "id">;

function MapCard({ data }: NodeProps<Node<Data>>) {
  const hit = !!data.affectedBy?.length;
  return (
    <div className={cn("grid h-full content-center gap-1 rounded-md border bg-card px-3 shadow-xs", hit ? "border-degraded-mark" : "border-line", data.href && "cursor-pointer")}>
      <Handle type="target" position={Position.Left} isConnectable={false} />
      <span className="flex min-w-0 items-center justify-between gap-2">
        <span className="truncate text-body-sm text-fg">{data.title}</span>
        <StatusChip health={data.chip.health} label={data.chip.label} />
      </span>
      <span className="truncate text-caption text-fg-3">{hit ? `Reads ${data.affectedBy!.join(", ")}` : data.line}</span>
      <Handle type="source" position={Position.Right} isConnectable={false} />
    </div>
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
  const nodes: Node<Data>[] = useMemo(() => input.map(({ id, ...data }) => ({
    id, type: "card", position: pos.get(id)!, width: W, height: H, data, draggable: false, selectable: false,
    ariaLabel: `${LANES[data.lane]}: ${data.title}. ${data.chip.label}. ${data.affectedBy?.length ? `Reads ${data.affectedBy.join(", ")}` : data.line}${data.href ? ". Enter opens its live day" : ""}`,
  })), [input, pos]);
  const edges: Edge[] = useMemo(() => links.map((e) => ({ id: e.id, source: e.source, target: e.target, focusable: false, style: { strokeWidth: e.width } })), [links]);
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
    <div ref={wrap} className="recon-canvas rounded-md border border-line" style={{ height: Math.min(640, Math.max(320, tall + 120)) }} onKeyDownCapture={onKey}>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} nodesConnectable={false} nodesDraggable={false} elementsSelectable={false} edgesFocusable={false}
        onNodeClick={(_, n) => { const h = input.find((x) => x.id === n.id)?.href; if (h) router.push(h); }}
        fitView fitViewOptions={{ padding: 0.12, maxZoom: 1 }} minZoom={0.3} maxZoom={1.5} proOptions={{ hideAttribution: true }}
        aria-label="Space map: the sources of the space and the recons that read them">
        <Background gap={24} />
        <Controls showInteractive={false} />
        <ViewportPortal>
          {LANES.map((name, l) => <div key={name} className="absolute text-label text-fg-2" style={{ transform: `translate(${l * (W + GAP_X)}px, -32px)` }}>{name}</div>)}
        </ViewportPortal>
      </ReactFlow>
    </div>
  );
}

export function SpaceMap(p: { nodes: MapNode[]; edges: MapEdge[] }) {
  return <ReactFlowProvider><MapCanvas {...p} /></ReactFlowProvider>;
}
