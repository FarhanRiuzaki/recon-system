import { RouteSkeleton } from "@/components/route-skeleton";
import { DASHBOARD_SHAPE } from "@/features/dashboard/shapes";

/** Loading shape of / (DASHBOARD_SHAPE: the admin section only for user.view or audit.view, as the page). */
export default function Loading() {
  return <RouteSkeleton sections={DASHBOARD_SHAPE} />;
}
