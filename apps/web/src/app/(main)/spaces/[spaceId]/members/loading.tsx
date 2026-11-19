import { RouteSkeleton, type Section } from "@/components/route-skeleton";

/** Loading shape of /spaces/[spaceId]/members at the 1440 px reference width: header, the members table, the role matrix. */
const SECTIONS: readonly Section[] = [
  { kind: "header", h: 50 },
  { kind: "table", chrome: 144, rows: "page", rowHeight: 52 },
  { kind: "panels", panels: [[12, 760]] },
];

export default function Loading() {
  return <RouteSkeleton sections={SECTIONS} />;
}
