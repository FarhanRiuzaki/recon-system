import type { Section } from "@/components/route-skeleton";

/**
 * Loading shape of / with the loaded page's sections at the 1440 px reference width (see route-skeleton): the header,
 * the Space and Recon pickers, five KPI tiles, results per day, the three breakdowns, the recons table and the sources table; then the
 * user and sign-in section as AdminSection draws it for user.view or audit.view: its heading, four tiles with
 * audit.view (three without: no failed sign-ins), the sign-ins row, and the recent activity with audit.view only.
 */
export const DASHBOARD_SHAPE: readonly Section[] = [
  { kind: "header", h: 50 },
  { kind: "bar", h: 32 },
  { kind: "kpi", h: 130, count: 5 },
  { kind: "panels", panels: [[12, 470]] },
  { kind: "panels", panels: [[6, 300], [6, 300]] },
  { kind: "table", chrome: 96, rows: 3 },
  { kind: "table", chrome: 96, rows: 3 },
  { kind: "bar", h: 28, perm: "audit.view" },
  { kind: "bar", h: 28, perm: "user.view", without: "audit.view" },
  { kind: "kpi", h: 130, count: 4, perm: "audit.view" },
  { kind: "kpi", h: 130, count: 3, perm: "user.view", without: "audit.view" },
  { kind: "panels", panels: [[12, 374]], perm: "audit.view" },
  { kind: "panels", panels: [[12, 374]], perm: "user.view", without: "audit.view" },
  { kind: "table", chrome: 96, rows: 5, rowHeight: 56, perm: "audit.view" },
];
