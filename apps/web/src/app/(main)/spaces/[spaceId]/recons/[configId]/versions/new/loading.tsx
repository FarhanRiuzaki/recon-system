import { RouteSkeleton } from "@/components/route-skeleton";
import { RECON_SETUP_SHAPE } from "@/features/recon/shapes";

export default function Loading() {
  return <RouteSkeleton sections={RECON_SETUP_SHAPE} />;
}
