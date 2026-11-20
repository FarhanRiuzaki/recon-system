import { RouteSkeleton } from "@/components/route-skeleton";
import { MEMBERS_SHAPE } from "@/features/spaces/shapes";

export default function Loading() {
  return <RouteSkeleton sections={MEMBERS_SHAPE} />;
}
