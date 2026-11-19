import { RouteSkeleton } from "@/components/route-skeleton";
import { SOURCES_SHAPE } from "@/features/sources/shapes";

export default function Loading() {
  return <RouteSkeleton sections={SOURCES_SHAPE} />;
}
