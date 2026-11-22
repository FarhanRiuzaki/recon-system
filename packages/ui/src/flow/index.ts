// The canvases' layer (DEC-041; owner 22 Nov: the canvas parts live in the design system): React Flow, themed on the
// tokens (flow.css, under a `.flow-canvas` wrapper), and the parts every canvas shares. Only this folder imports
// @xyflow/react (architecture.test.ts); the styles are imported by the parts themselves (flow-parts, table-node), since
// the package is side-effect free but for CSS and a bundler skips this index; a canvas loads on demand (next/dynamic), so none of it is in a first load.

export {
  Background, BackgroundVariant, BaseEdge, ControlButton, Controls, type Connection, type Edge, type EdgeProps, getBezierPath, type OnConnect,
  Handle, type Node, type NodeChangeset, type NodeProps, Position, ReactFlow, ReactFlowProvider, useEdgesState, useNodesInitialized, useNodesState, useReactFlow,
  ViewportPortal,
} from "@xyflow/react";
export { type Accent, arrowOf, EDGE_TYPES, type EdgeTone, FIT, FlowBadge, FlowBoard, FlowCard, FlowEdge, type FlowEdgeData, LaneTitle, pathOf, PortHandles, type Ports, ports, portsOf, ResetLayout, useFitToCard, useHotNode } from "./flow-parts";
export { TableCard, type TableCardProps, TableNode, type TableNodeType, type TableRow } from "./table-node";
export { MapEdge, type MapEdgeType } from "./map-edge";
