import type { Section } from "@/components/route-skeleton";

// Loading shapes of this feature's screens, imported by each route's loading.tsx and by components/route-shapes.ts.

/** /spaces/[spaceId]/reports (Files) and …/reports/templates at 1440 px: header, the route tabs, the table. */
export const REPORT_FILES_SHAPE: readonly Section[] = [{ kind: "header", h: 50 }, { kind: "bar", h: 40 }, { kind: "table", chrome: 144, rows: "page", rowHeight: 56 }];
export const REPORT_TEMPLATES_SHAPE: readonly Section[] = [{ kind: "header", h: 50 }, { kind: "bar", h: 40 }, { kind: "table", chrome: 144, rows: "page", rowHeight: 52 }];
/** …/reports/templates/[templateId]: header, its tabs, the overview's two cards. */
export const REPORT_TEMPLATE_SHAPE: readonly Section[] = [{ kind: "header", h: 50 }, { kind: "bar", h: 40 }, { kind: "panels", panels: [[6, 220], [6, 220]] }];
