import { RouteSkeleton } from "@/components/route-skeleton";
import { FEEDS_SHAPE } from "@/features/imports/shapes";

/** Loading shape of /imports/feeds. */
export default function Loading() {
  return <RouteSkeleton sections={FEEDS_SHAPE} />;
}
