import { RouteSkeleton, type Section } from "@/components/route-skeleton";

/**
 * Loading shape of / with the loaded page's sections at the 1440 px reference width (see route-skeleton): the header,
 * the Space and Recon pickers, five KPI tiles, results per day, the three breakdowns and the recons table; the user
 * and sign-in section under it only for user.view or audit.view (like the page).
 */
const SECTIONS: readonly Section[] = [
  { kind: "header", h: 50 },
  { kind: "bar", h: 32 },
  { kind: "kpi", h: 130, count: 5 },
  { kind: "panels", panels: [[12, 470]] },
  { kind: "panels", panels: [[6, 300], [6, 300]] },
  { kind: "table", chrome: 96, rows: 3 },
  { kind: "panels", panels: [[12, 374]], perm: "audit.view" },
];

export default function Loading() {
  return <RouteSkeleton sections={SECTIONS} />;
}
