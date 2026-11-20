import { RouteSkeleton } from "@/components/route-skeleton";
import { RECON_SHAPE } from "@/features/recon/shapes";

export default function Loading() {
  return <RouteSkeleton sections={RECON_SHAPE} />;
}
