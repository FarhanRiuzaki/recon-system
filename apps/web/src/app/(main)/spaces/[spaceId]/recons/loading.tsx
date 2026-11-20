import { RouteSkeleton } from "@/components/route-skeleton";
import { RECONS_SHAPE } from "@/features/recon/shapes";

export default function Loading() {
  return <RouteSkeleton sections={RECONS_SHAPE} />;
}
