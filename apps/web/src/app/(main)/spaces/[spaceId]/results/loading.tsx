import { RouteSkeleton } from "@/components/route-skeleton";
import { RESULTS_SHAPE } from "@/features/results/shapes";

export default function Loading() {
  return <RouteSkeleton sections={RESULTS_SHAPE} />;
}
