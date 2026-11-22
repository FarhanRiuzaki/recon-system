import { RouteSkeleton } from "@/components/route-skeleton";
import { RULES_SHAPE } from "@/features/approvals/shapes";

export default function Loading() {
  return <RouteSkeleton sections={RULES_SHAPE} />;
}
