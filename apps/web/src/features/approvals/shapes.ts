import type { Section } from "@/components/route-skeleton";

// Loading shape of the approvals screen, apart from it so loading.tsx never pulls the screen's code into the first load.

/** /spaces/[spaceId]/approvals: the header and the requests table. */
export const APPROVALS_SHAPE: readonly Section[] = [
  { kind: "header", h: 68 },
  { kind: "table", chrome: 144, rows: "page", rowHeight: 56 },
];

/** /spaces/[spaceId]/workflows: the header and the workflows table. */
export const LIBRARY_SHAPE: readonly Section[] = [
  { kind: "header", h: 68 },
  { kind: "table", chrome: 144, rows: "page", rowHeight: 56 },
];
/** /spaces/[spaceId]/workflows/[id]: the header, the chain beside Used by. */
export const LIBRARY_EDITOR_SHAPE: readonly Section[] = [
  { kind: "header", h: 68 },
  { kind: "panels", panels: [[6, 520], [6, 360]] },
];
