"use client";

// The action editor's canvas (owner 22 Nov: "seperti setup ERD … bisa digeser, ditarik dari ujung ke ujung"): the
// recon's fields as tables on the left, the operation's request as a table on the right, a line per field a mapping
// reads. Drag from a row's end to a request field's end to map it; click a request field or a line to open it in the
// inspector; Delete removes the selected line's mapping. Tables move by drag; Reset layout puts them back. Every
// mapping can also be made in the inspector or the list (no drag needed).
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Controls, FIT, FlowBoard, MapEdge, type MapEdgeType, type OnConnect, ReactFlow, ReactFlowProvider, ResetLayout,
  TableNode, type TableNodeType, type TableRow, useFitToCard, useNodesInitialized, useNodesState, useReactFlow,
} from "@starterkit/ui/flow";
import { readPath } from "@starterkit/shared/integrations";
import type { mapGraph } from "./field-map";

type Graph = ReturnType<typeof mapGraph>;
const NODE_TYPES = { table: TableNode };
const EDGE_TYPES = { map: MapEdge };
const ROW_H = 32, HEAD_H = 52, GAP = 28, COL = 320, LANE = 160;

/**
 * Where each table sits at first: the sources in columns on the left (a new column once one is as tall as the request
 * or 900 px: two columns for a usual recon), the request on the right of them, level with the top, so the map fits the screen at reading size.
 */
function layout(g: Graph): Record<string, { x: number; y: number }> {
  const at: Record<string, { x: number; y: number }> = {};
  const tall = (rows: number) => HEAD_H + rows * ROW_H;
  const max = Math.max(900, tall(g.request.length));
  let col = 0, y = 0;
  for (const t of g.sources) {
    if (y > 0 && y + tall(t.rows.length) > max) { col++; y = 0; }
    at[t.id] = { x: col * (COL + GAP), y };
    y += tall(t.rows.length) + GAP;
  }
  at.request = { x: (col + 1) * (COL + GAP) + LANE, y: 0 };
  return at;
}

/** A value as a short example ("" = empty). */
const shown = (v: unknown) => (v === undefined || v === null ? undefined : v === "" ? "(empty)" : typeof v === "object" ? JSON.stringify(v) : String(v));
const KIND: Record<string, string> = { money: "amount", number: "number", text: "text", date: "date", list: "list", account: "account" };

function Canvas({ graph, title, caption, selected, onSelect, onConnect, onRemove, examples }: {
  graph: Graph; title: string; caption: string; selected: string | null;
  /** A real break's values (context) and what would be sent (payload), once the preview has run. */
  examples: { context: Record<string, unknown>; payload: unknown } | null;
  onSelect: (path: string | null) => void; onConnect: (row: string, target: string) => void; onRemove: (target: string) => void;
}) {
  const home = useMemo(() => layout(graph), [graph]);
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({});
  const build = (): TableNodeType[] => [
    ...graph.sources.map((t): TableNodeType => ({
      id: t.id, type: "table", position: moved[t.id] ?? home[t.id]!, deletable: false, width: COL,
      data: { title: t.title, caption: t.caption, side: "source", rows: t.rows.map((r): TableRow => ({
        id: r.key, label: r.label, connectable: true, state: graph.edges.some((e) => e.row === r.key) ? "mapped" : null,
        type: KIND[r.kind] ?? r.kind, example: examples ? shown(examples.context[r.key]) : undefined,
      })) },
    })),
    {
      id: "request", type: "table", position: moved.request ?? home.request!, deletable: false, width: COL,
      data: {
        title, caption, side: "target", onRowSelect: (id) => onSelect(id),
        rows: graph.request.map((r): TableRow => ({
          id: r.path, label: r.name, depth: r.depth, header: !r.leaf, required: r.leaf && r.required, connectable: r.leaf && !r.filledBy, selected: r.path === selected,
          state: !r.leaf ? null : r.filledBy ?? (r.mapped ? "mapped" : r.required ? "missing" : null),
          // what would be sent when the preview has run, else what fills it
          example: examples && r.leaf ? shown(readPath(examples.payload, r.path)) : undefined,
          note: examples && r.leaf && shown(readPath(examples.payload, r.path)) !== undefined ? undefined
            : r.mapped === "const" ? "Fixed value" : r.mapped === "template" ? "Template" : r.mapped === "lookup" ? "Lookup" : undefined,
          type: r.leaf ? r.type : undefined, limit: r.maxLength ? `≤ ${r.maxLength}` : undefined,
        })),
      },
    },
  ];
  const [nodes, setNodes, onNodesChange] = useNodesState<TableNodeType>(build());
  // the graph or the selection changed: new rows, same places
  // new rows, same places; each node keeps React Flow's measurement (a node without it is measured again, which reads as
  // "not initialized" and refit the view after every click — final review I1)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setNodes((prev) => build().map((n) => { const p = prev.find((x) => x.id === n.id); return p ? { ...p, ...n, measured: p.measured } : n; })), [graph, selected, moved, title, caption, examples]);
  const edges: MapEdgeType[] = graph.edges.map((e) => ({
    id: e.id, type: "map", source: e.source, sourceHandle: e.row, target: "request", targetHandle: e.target, data: { label: e.label }, selected: e.target === selected,
    zIndex: 1000, // above the tables (a line to the request may cross a table between)
  }));
  const wrap = useRef<HTMLDivElement>(null);
  useFitToCard(wrap, graph.sources.length * 100 + graph.request.length);
  // and once the tables are measured (a fit before that sees empty boxes and zooms too far out)
  const measured = useNodesInitialized();
  const { fitView } = useReactFlow();
  const fitted = useRef(false);
  useEffect(() => { if (measured && !fitted.current) { fitted.current = true; void fitView(FIT); } }, [measured, fitView]);
  const connect: OnConnect = (c) => { if (c.sourceHandle && c.targetHandle) onConnect(c.sourceHandle, c.targetHandle); };
  return (
    // Delete removes the open field's mapping while the map has focus (never Backspace, never from a form control:
    // React Flow's own delete key is off, a mapping has no undo)
    <div ref={wrap} className="flow-canvas absolute inset-0"
      onKeyDown={(e) => { if (e.key === "Delete" && selected && !(e.target as HTMLElement).closest("input, textarea, select, button")) onRemove(selected); }}>
      <ReactFlow<TableNodeType, MapEdgeType> nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange} onConnect={connect} fitView fitViewOptions={FIT} minZoom={0.3} maxZoom={1.5}
        onNodeDragStop={(_, n) => setMoved((m) => ({ ...m, [n.id]: n.position }))}
        onEdgeClick={(_, e) => onSelect((e as MapEdgeType).targetHandle ?? null)}
        deleteKeyCode={null}
        onPaneClick={() => onSelect(null)}
        isValidConnection={(c) => graph.request.some((r) => r.path === c.targetHandle && r.leaf && !r.filledBy)}
        aria-label="Field map: recon fields on the left, the request on the right" proOptions={{ hideAttribution: true }}>
        <FlowBoard />
        <Controls showInteractive={false} position="bottom-left">
          <ResetLayout onReset={() => { setMoved({}); requestAnimationFrame(() => void fitView(FIT)); }} />
        </Controls>
      </ReactFlow>
    </div>
  );
}

/** The field map of one variant (loaded with the editor). */
export function FieldMapCanvas(p: Parameters<typeof Canvas>[0]) {
  return <ReactFlowProvider><Canvas {...p} /></ReactFlowProvider>;
}
