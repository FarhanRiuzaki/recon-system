import { RouteSkeleton } from "@/components/route-skeleton";
import { CONNECTORS_SHAPE } from "@/features/integrations/shapes";

export default function Loading() {
  return <RouteSkeleton sections={CONNECTORS_SHAPE} />;
}
