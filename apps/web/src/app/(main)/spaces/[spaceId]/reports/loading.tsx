import { RouteSkeleton } from "@/components/route-skeleton";
import { REPORT_FILES_SHAPE } from "@/features/reports/shapes";

export default function Loading() {
  return <RouteSkeleton sections={REPORT_FILES_SHAPE} />;
}
