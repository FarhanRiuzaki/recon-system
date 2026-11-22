import { RouteSkeleton } from "@/components/route-skeleton";
import { WORKFLOW_SHAPE } from "@/features/approvals/shapes";

export default function Loading() {
  return <RouteSkeleton sections={WORKFLOW_SHAPE} />;
}
