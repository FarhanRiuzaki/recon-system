import { RouteSkeleton } from "@/components/route-skeleton";
import { WORKFLOWS_SHAPE } from "@/features/approvals/shapes";

export default function Loading() {
  return <RouteSkeleton sections={WORKFLOWS_SHAPE} />;
}
