import type { Section } from "@/components/route-skeleton";

// Loading shapes of this feature's screens: imported by each route's loading.tsx and by the screen itself (LoadingShape),
// kept apart so a loading.tsx never pulls a screen's code into the route's first load. Heights at the 1440 px reference width.

/** /spaces/[spaceId]/recons: the header and the recons table. */
export const RECONS_SHAPE: readonly Section[] = [
  { kind: "header", h: 68 },
  { kind: "table", chrome: 144, rows: "page", rowHeight: 56 },
];

/** /spaces/[spaceId]/recons/new: the header and the form. */
export const NEW_RECON_SHAPE: readonly Section[] = [
  { kind: "header", h: 68 },
  { kind: "panels", panels: [[12, 320]] },
];

/** A recon (its Overview, the default tab): the header, the tabs, Today (the day's numbers, the Run card), Needs action. */
export const RECON_SHAPE: readonly Section[] = [
  { kind: "header", h: 50 },
  { kind: "bar", h: 28 },
  { kind: "panels", panels: [[12, 150]] },
  { kind: "panels", panels: [[12, 220]] },
  { kind: "panels", panels: [[12, 320]] },
];

/** A recon's setup (versions/new): the header, the step's panels beside the steps rail. */
export const RECON_SETUP_SHAPE: readonly Section[] = [
  { kind: "header", h: 68 },
  { kind: "panels", panels: [[12, 480]] },
];

/** A recon version: the header, its passes and settings, the decision. */
export const RECON_VERSION_SHAPE: readonly Section[] = [
  { kind: "header", h: 68 },
  { kind: "panels", panels: [[12, 56]] },
  { kind: "panels", panels: [[12, 480]] },
];

/** A run's results: the header, the run's summary, the per-date strip with the pass tabs and the items table. */
export const RECON_RUN_SHAPE: readonly Section[] = [
  { kind: "header", h: 68 },
  { kind: "panels", panels: [[12, 96]] },
  { kind: "panels", panels: [[12, 640]] },
];

/** /spaces/[spaceId]/today: the header, the KPI tray, the space map and the recons table. */
export const TODAY_SHAPE: readonly Section[] = [
  { kind: "header", h: 68 },
  { kind: "kpi", h: 136, count: 4 },
  { kind: "panels", panels: [[12, 420]] },
  { kind: "table", chrome: 96, rows: 5, rowHeight: 56 },
];

/** A recon's live day (its Overview's frame): the header, the tabs, the day's numbers, the Run card, Needs action. */
export const LIVE_DAY_SHAPE: readonly Section[] = [
  { kind: "header", h: 50 },
  { kind: "bar", h: 28 },
  { kind: "panels", panels: [[12, 150]] },
  { kind: "panels", panels: [[12, 220]] },
  { kind: "panels", panels: [[12, 320]] },
];
