import type { Section } from "@/components/route-skeleton";

// Loading shapes of the Import screens: imported by each route's loading.tsx and by the screen itself (LoadingShape),
// kept apart so a loading.tsx never pulls a screen's code into the route's first load. Heights at the 1440 px reference.

/** /imports (Monitoring): the header, the Today tray, the schedulers card and the date grid. */
export const MONITORING_SHAPE: readonly Section[] = [
  { kind: "header", h: 50 },
  { kind: "kpi", h: 104, count: 5 },
  { kind: "panels", panels: [[12, 220]] },
  { kind: "panels", panels: [[12, 260]] },
];
/** /imports/feeds: the header and the feeds table. */
export const FEEDS_SHAPE: readonly Section[] = [{ kind: "header", h: 50 }, { kind: "table", chrome: 144, rows: "page", rowHeight: 52 }];
/** /imports/feeds/new and /imports/feeds/[feedId]: the header and the form card. */
export const FEED_FORM_SHAPE: readonly Section[] = [{ kind: "header", h: 50 }, { kind: "panels", panels: [[12, 520]] }];
