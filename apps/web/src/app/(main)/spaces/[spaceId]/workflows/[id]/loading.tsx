import { RouteSkeleton } from "@/components/route-skeleton";
import { LIBRARY_EDITOR_SHAPE } from "@/features/approvals/shapes";

export default function Loading() {
  return <RouteSkeleton sections={LIBRARY_EDITOR_SHAPE} />;
}
