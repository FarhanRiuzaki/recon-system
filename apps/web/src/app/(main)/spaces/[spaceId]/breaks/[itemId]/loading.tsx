import { RouteSkeleton } from "@/components/route-skeleton";
import { BREAK_SHAPE } from "@/features/breaks/shapes";

export default function Loading() {
  return <RouteSkeleton sections={BREAK_SHAPE} />;
}
