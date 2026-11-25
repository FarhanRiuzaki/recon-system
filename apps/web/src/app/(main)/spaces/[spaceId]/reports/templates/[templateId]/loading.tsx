import { RouteSkeleton } from "@/components/route-skeleton";
import { REPORT_TEMPLATE_SHAPE } from "@/features/reports/shapes";

export default function Loading() {
  return <RouteSkeleton sections={REPORT_TEMPLATE_SHAPE} />;
}
