import type { Section } from "@/components/route-skeleton";

// Loading shapes of this feature's screens, imported by each route's loading.tsx and by components/route-shapes.ts.

/** /spaces/[spaceId]/members at the 1440 px reference width: header, the members table, the role matrix. */
export const MEMBERS_SHAPE: readonly Section[] = [
  { kind: "header", h: 50 },
  { kind: "table", chrome: 144, rows: "page", rowHeight: 52 },
  { kind: "panels", panels: [[12, 760]] },
];
