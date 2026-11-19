import { RouteSkeleton } from "@/components/route-skeleton";
import { SOURCE_DETAIL_SHAPE } from "@/features/sources/shapes";

/** Loading shape of a source's detail: the same sections the screen shows while its data loads (SOURCE_DETAIL_SHAPE). */
export default function Loading() {
  return <RouteSkeleton sections={SOURCE_DETAIL_SHAPE} />;
}
