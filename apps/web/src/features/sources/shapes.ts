import type { Section } from "@/components/route-skeleton";

// Loading shapes of this feature's screens: imported by each route's loading.tsx and by the screen itself (LoadingShape),
// kept apart so a loading.tsx never pulls a screen's code into the route's first load. Heights at the 1440 px reference width.

/** /spaces/[spaceId]/sources: the header, the summary tiles and the sources table. */
export const SOURCES_SHAPE: readonly Section[] = [
  { kind: "header", h: 68 },
  { kind: "kpi", h: 136, count: 4 },
  { kind: "table", chrome: 144, rows: "page", rowHeight: 56 },
];

/** /spaces/[spaceId]/sources/[sourceId]: the header, the tabs, today's tiles and the source's table. */
export const SOURCE_DETAIL_SHAPE: readonly Section[] = [
  { kind: "header", h: 50 },
  { kind: "bar", h: 28 },
  { kind: "kpi", h: 136, count: 4 },
  { kind: "table", chrome: 144, rows: 4, rowHeight: 60 },
];

/** The source wizard (new source, edit source): the header and its first step's panels beside the progress rail. */
export const WIZARD_SHAPE: readonly Section[] = [
  { kind: "header", h: 68 },
  { kind: "panels", panels: [[12, 160]] },
  { kind: "panels", panels: [[12, 200]] },
];

/** A source version: the header, its changes, the preview and the decision. */
export const VERSION_SHAPE: readonly Section[] = [
  { kind: "header", h: 68 },
  { kind: "table", chrome: 120, rows: 3, rowHeight: 44 },
  { kind: "panels", panels: [[12, 140]] },
  { kind: "panels", panels: [[12, 200]] },
];
