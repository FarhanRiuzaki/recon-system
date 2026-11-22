import { RouteSkeleton } from "@/components/route-skeleton";
import { CONNECTOR_SHAPE } from "@/features/integrations/shapes";

export default function Loading() {
  return <RouteSkeleton sections={CONNECTOR_SHAPE} />;
}
