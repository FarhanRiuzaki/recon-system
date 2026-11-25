// The field map's graph (shared by the recon posting editor and the source mapper): source tables on the left, one
// target table on the right, an edge per mapping that reads a source row. Pure.
import type { CSSProperties } from "react";

export type MapSourceTable = { id: string; title: string; caption: string | null; rows: { key: string; label: string; kind: string }[] };
export type MapTargetRow = {
  path: string; name: string; depth: number; leaf: boolean; required: boolean; type: string; maxLength: number | null;
  /** The far side fills it itself (a fixed or auto value): no source may be connected. */
  filledBy: "fixed" | "auto" | null;
  /** The kind of source mapped to it, if any. */
  mapped: string | null;
  /** A short word on the row (a formula, why it is broken); `broken` shows it as a problem. */
  note?: string; broken?: boolean;
  /** A folded group (the source mapper's extra attributes): how many it holds; no handle. */
  folded?: number;
};
export type MapEdge = { id: string; source: string; row: string; target: string; label: string | null; dashed?: boolean };
export type MapGraph = { sources: MapSourceTable[]; request: MapTargetRow[]; edges: MapEdge[]; missing: string[] };

/** The line's style: a JSON-path mapping is dashed. */
export const edgeStyle = (e: { dashed?: boolean }): CSSProperties | undefined => (e.dashed ? { strokeDasharray: "4 4" } : undefined);
