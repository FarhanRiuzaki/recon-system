"use client";

// The builder canvas loads on demand (REC-S6: React Flow stays out of the builder's first load, DEC-040), inside a
// ChunkBoundary; until it arrives, the four lanes' loading shape.
import dynamic from "next/dynamic";
import { ChunkBoundary } from "@starterkit/ui/ds/chunk-boundary";
import { Skeleton } from "@starterkit/ui/ui/skeleton";
import type { CanvasProps } from "./recon-canvas";

function CanvasShape() {
  return (
    <div className="grid h-90 grid-cols-4 gap-8 p-6" aria-busy="true" aria-label="Loading the canvas">
      {[2, 2, 3, 4].map((n, l) => <div key={l} className="grid content-center gap-4">{Array.from({ length: n }, (_, i) => <Skeleton key={i} className="h-16 rounded-md" />)}</div>)}
    </div>
  );
}
const Canvas = dynamic(() => import("./recon-canvas").then((m) => m.ReconCanvas), { ssr: false, loading: CanvasShape });

export function CanvasLoader(p: CanvasProps) {
  return <ChunkBoundary><Canvas {...p} /></ChunkBoundary>;
}
