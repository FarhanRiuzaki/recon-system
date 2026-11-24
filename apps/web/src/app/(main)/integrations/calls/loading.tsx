import { RouteSkeleton } from "@/components/route-skeleton";
import { CALLS_SHAPE } from "@/features/integrations/shapes";

export default function Loading() {
  return <RouteSkeleton sections={CALLS_SHAPE} />;
}
