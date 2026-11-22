import { RouteSkeleton } from "@/components/route-skeleton";
import { APPROVALS_SHAPE } from "@/features/approvals/shapes";

export default function Loading() {
  return <RouteSkeleton sections={APPROVALS_SHAPE} />;
}
