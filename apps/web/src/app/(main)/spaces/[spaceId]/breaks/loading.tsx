import { RouteSkeleton } from "@/components/route-skeleton";
import { BREAKS_SHAPE } from "@/features/breaks/shapes";

export default function Loading() {
  return <RouteSkeleton sections={BREAKS_SHAPE} />;
}
