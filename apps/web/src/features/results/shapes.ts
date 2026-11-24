import type { Section } from "@/components/route-skeleton";

// Loading shape of Operation result, apart from it so loading.tsx never pulls the screen's code into the first load.

/** /spaces/[spaceId]/results: the header and the results table (its counts strip in the table's chrome). */
export const RESULTS_SHAPE: readonly Section[] = [
  { kind: "header", h: 68 },
  { kind: "table", chrome: 196, rows: "page", rowHeight: 52 },
];
