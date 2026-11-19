import { RouteSkeleton } from "@/components/route-skeleton";
import { VERSION_SHAPE } from "@/features/sources/shapes";

/** Loading shape of a source version (VERSION_SHAPE). */
export default function Loading() {
  return <RouteSkeleton sections={VERSION_SHAPE} />;
}
