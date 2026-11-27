import { RouteSkeleton } from "@/components/route-skeleton";
import { MONITORING_SHAPE } from "@/features/imports/shapes";

/** Loading shape of /imports (Monitoring); the pages below it are listed in ROUTE_SHAPES. */
export default function Loading() {
  return <RouteSkeleton sections={MONITORING_SHAPE} />;
}
