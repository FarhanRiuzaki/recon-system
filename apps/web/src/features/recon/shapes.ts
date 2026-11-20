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

/** A recon (BUILDER-SPEC loading): the header, the tabs, the simulation bar, the settings strip and the passes. */
export const RECON_SHAPE: readonly Section[] = [
  { kind: "header", h: 50 },
  { kind: "bar", h: 28 },
  { kind: "panels", panels: [[12, 72]] },
  { kind: "panels", panels: [[12, 56]] },
  { kind: "panels", panels: [[12, 560]] },
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
