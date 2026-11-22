import type { Section } from "@/components/route-skeleton";

// Loading shape of the breaks queue, apart from it so loading.tsx never pulls the screen's code into the first load.

/** /spaces/[spaceId]/breaks: the header, the KPI tray and the breaks table. */
export const BREAKS_SHAPE: readonly Section[] = [
  { kind: "header", h: 68 },
  { kind: "kpi", h: 136, count: 4 },
  { kind: "table", chrome: 144, rows: "page", rowHeight: 56 },
];

/** /spaces/[spaceId]/breaks/[itemId]: the header, the comparison (Summary), the action cards (What you can do), the trail. */
export const BREAK_SHAPE: readonly Section[] = [
  { kind: "header", h: 88 },
  { kind: "panels", panels: [[12, 220]] },
  { kind: "panels", panels: [[6, 180], [6, 180]] },
  { kind: "panels", panels: [[12, 280]] },
];
/** Its What you can do zone alone, while the space's roles (who may act) load. */
export const BREAK_ACT_SHAPE: readonly Section[] = [BREAK_SHAPE[2]!];

