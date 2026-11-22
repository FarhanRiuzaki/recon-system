import { RouteSkeleton } from "@/components/route-skeleton";
import { POSTING_SHAPE } from "@/features/integrations/shapes";

export default function Loading() {
  return <RouteSkeleton sections={POSTING_SHAPE} />;
}
