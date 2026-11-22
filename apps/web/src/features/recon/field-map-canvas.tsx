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
import type { mapGraph } from "./field-map";

type Graph = ReturnType<typeof mapGraph>;
const NODE_TYPES = { table: TableNode };
const EDGE_TYPES = { map: MapEdge };
const ROW_H = 32, HEAD_H = 52, GAP = 28, COL = 288, LANE = 220;

/**
 * Where each table sits at first: the sources in columns on the left (a new column once one is as tall as the request
 * or 640 px), the request on the right of them, level with the top, so the map fits the screen at reading size.
 */
function layout(g: Graph): Record<string, { x: number; y: number }> {
  const at: Record<string, { x: number; y: number }> = {};
  const tall = (rows: number) => HEAD_H + rows * ROW_H;
  const max = Math.max(640, tall(g.request.length));
  let col = 0, y = 0;
  for (const t of g.sources) {
    if (y > 0 && y + tall(t.rows.length) > max) { col++; y = 0; }
    at[t.id] = { x: col * (COL + GAP), y };
    y += tall(t.rows.length) + GAP;
  }
  at.request = { x: (col + 1) * (COL + GAP) + LANE, y: 0 };
  return at;
}

function Canvas({ graph, title, caption, selected, onSelect, onConnect, onRemove }: {
  graph: Graph; title: string; caption: string; selected: string | null;
  onSelect: (path: string | null) => void; onConnect: (row: string, target: string) => void; onRemove: (target: string) => void;
}) {
  const home = useMemo(() => layout(graph), [graph]);
  const [moved, setMoved] = useState<Record<string, { x: number; y: number }>>({});
  const build = (): TableNodeType[] => [
    ...graph.sources.map((t): TableNodeType => ({
      id: t.id, type: "table", position: moved[t.id] ?? home[t.id]!, deletable: false,
      data: { title: t.title, caption: t.caption, side: "source", rows: t.rows.map((r): TableRow => ({ id: r.key, label: r.label, connectable: true, state: graph.edges.some((e) => e.row === r.key) ? "mapped" : null })) },
    })),
    {
      id: "request", type: "table", position: moved.request ?? home.request!, deletable: false,
      data: {
        title, caption, side: "target", onRowSelect: (id) => onSelect(id),
        rows: graph.request.map((r): TableRow => ({
          id: r.path, label: r.name, depth: r.depth, header: !r.leaf, required: r.leaf && r.required, connectable: r.leaf && !r.filledBy, selected: r.path === selected,
          state: !r.leaf ? null : r.filledBy ?? (r.mapped ? "mapped" : r.required ? "missing" : null),
          note: r.mapped === "const" ? "Fixed value" : r.mapped === "template" ? "Template" : r.mapped === "lookup" ? "Lookup" : undefined,
        })),
      },
    },
  ];
  const [nodes, setNodes, onNodesChange] = useNodesState<TableNodeType>(build());
  // the graph or the selection changed: new rows, same places
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setNodes(build()), [graph, selected, moved, title, caption]);
  const edges: MapEdgeType[] = graph.edges.map((e) => ({
    id: e.id, type: "map", source: e.source, sourceHandle: e.row, target: "request", targetHandle: e.target, data: { label: e.label }, selected: e.target === selected,
  }));
  const wrap = useRef<HTMLDivElement>(null);
  useFitToCard(wrap, graph.sources.length * 100 + graph.request.length);
  // and once the tables are measured (a fit before that sees empty boxes and zooms too far out)
  const measured = useNodesInitialized();
  const { fitView } = useReactFlow();
  useEffect(() => { if (measured) void fitView(FIT); }, [measured, fitView]);
  const connect: OnConnect = (c) => { if (c.sourceHandle && c.targetHandle) onConnect(c.sourceHandle, c.targetHandle); };
  return (
    <div ref={wrap} className="flow-canvas absolute inset-0">
      <ReactFlow<TableNodeType, MapEdgeType> nodes={nodes} edges={edges} nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES}
        onNodesChange={onNodesChange} onConnect={connect} fitView fitViewOptions={FIT} minZoom={0.3} maxZoom={1.5}
        onNodeDragStop={(_, n) => setMoved((m) => ({ ...m, [n.id]: n.position }))}
        onEdgeClick={(_, e) => onSelect((e as MapEdgeType).targetHandle ?? null)}
        onEdgesDelete={(es) => es.forEach((e) => e.targetHandle && onRemove(e.targetHandle))}
        onPaneClick={() => onSelect(null)}
        isValidConnection={(c) => graph.request.some((r) => r.path === c.targetHandle && r.leaf && !r.filledBy)}
        aria-label="Field map: recon fields on the left, the request on the right" proOptions={{ hideAttribution: true }}>
        <FlowBoard />
        <Controls showInteractive={false} position="bottom-left">
          <ResetLayout onReset={() => setMoved({})} />
        </Controls>
      </ReactFlow>
    </div>
  );
}

/** The field map of one variant (loaded with the editor). */
export function FieldMapCanvas(p: Parameters<typeof Canvas>[0]) {
  return <ReactFlowProvider><Canvas {...p} /></ReactFlowProvider>;
}
