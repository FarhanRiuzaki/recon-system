import { RouteSkeleton, type Section } from "@/components/route-skeleton";

/** Loading shape of /spaces: it opens a space's members (header and the members table), or the no-space card. */
const SECTIONS: readonly Section[] = [
  { kind: "header", h: 50 },
  { kind: "table", chrome: 144, rows: 5, rowHeight: 52 },
];

export default function Loading() {
  return <RouteSkeleton sections={SECTIONS} />;
}
