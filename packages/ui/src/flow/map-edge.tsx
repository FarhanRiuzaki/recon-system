"use client";

// A mapping line on an ERD canvas: a bezier from a source row's end to a target row's end, its label (the changes a
// value goes through, "template", "lookup …") as a pill on the curve; selected = primary and thicker.
import { BaseEdge, type Edge, EdgeLabelRenderer, type EdgeProps, getBezierPath } from "@xyflow/react";
import { cn } from "../lib/cn";

export type MapEdgeType = Edge<{ label: string | null }, "map">;
export function MapEdge(p: EdgeProps<MapEdgeType>) {
  const [path, x, y] = getBezierPath({ ...p, curvature: 0.4 });
  return (
    <>
      {/* a halo in the card's colour under the line: it reads where it crosses a table (lines sit above tables) */}
      <path d={path} className="flow-map-halo" fill="none" />
      <BaseEdge id={p.id} path={path} interactionWidth={18} style={p.style} className={cn("flow-map-edge", p.selected && "is-selected")} />
      {p.data?.label && (
        <EdgeLabelRenderer>
          <span className={cn("flow-label nodrag nopan", p.selected && "is-selected")} style={{ transform: `translate(-50%, -50%) translate(${x}px, ${y}px)` }}>{p.data.label}</span>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
