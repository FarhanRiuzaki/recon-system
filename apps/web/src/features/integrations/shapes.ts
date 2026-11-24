import type { Section } from "@/components/route-skeleton";

// Loading shapes of the Open API screens, apart from them so loading.tsx never pulls the screens' code into the first load.

/** /integrations: the header, the Open API tabs and the connectors table. */
export const CONNECTORS_SHAPE: readonly Section[] = [
  { kind: "header", h: 68 },
  { kind: "bar", h: 28 },
  { kind: "table", chrome: 144, rows: "page", rowHeight: 56 },
];
/** /integrations/calls: the header, the tabs and the calls table. */
export const CALLS_SHAPE: readonly Section[] = [
  { kind: "header", h: 68 },
  { kind: "bar", h: 28 },
  { kind: "table", chrome: 144, rows: "page", rowHeight: 56 },
];
/** /integrations/[id]: the header, the section switch, the two environment cards. */
export const CONNECTOR_SHAPE: readonly Section[] = [
  { kind: "header", h: 68 },
  { kind: "panels", panels: [[6, 520], [6, 520]] },
];
/** /spaces/[spaceId]/posting: the header and the runs table. */
export const POSTING_SHAPE: readonly Section[] = [
  { kind: "header", h: 68 },
  { kind: "table", chrome: 144, rows: "page", rowHeight: 56 },
];
