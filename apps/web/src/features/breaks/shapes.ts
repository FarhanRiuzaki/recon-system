import type { Section } from "@/components/route-skeleton";

// Loading shape of the breaks queue, apart from it so loading.tsx never pulls the screen's code into the first load.

/** /spaces/[spaceId]/breaks: the header and the breaks table. */
export const BREAKS_SHAPE: readonly Section[] = [
  { kind: "header", h: 68 },
  { kind: "table", chrome: 144, rows: "page", rowHeight: 56 },
];

/** /spaces/[spaceId]/breaks/[itemId]: the header, the break, the counterparts, the trail. */
export const BREAK_SHAPE: readonly Section[] = [
  { kind: "header", h: 68 },
  { kind: "panels", panels: [[12, 240]] },
  { kind: "panels", panels: [[12, 360]] },
];

