import type { Section } from "@/components/route-skeleton";

// Loading shapes of this feature's screens: imported by each route's loading.tsx and by the screen itself (LoadingShape),
// kept apart so a loading.tsx never pulls a screen's code into the route's first load. Heights at the 1440 px reference width.

/** /spaces/[spaceId]/sources: the header and the sources table. */
export const SOURCES_SHAPE: readonly Section[] = [
  { kind: "header", h: 68 },
  { kind: "table", chrome: 144, rows: "page", rowHeight: 56 },
];

/** /spaces/[spaceId]/sources/[sourceId]: the header, the tabs, one notice and the source's table. */
export const SOURCE_DETAIL_SHAPE: readonly Section[] = [
  { kind: "header", h: 50 },
  { kind: "bar", h: 28 },
  { kind: "table", chrome: 144, rows: 4, rowHeight: 60 },
];
