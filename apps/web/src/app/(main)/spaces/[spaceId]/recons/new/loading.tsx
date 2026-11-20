import { RouteSkeleton } from "@/components/route-skeleton";
import { NEW_RECON_SHAPE } from "@/features/recon/shapes";

export default function Loading() {
  return <RouteSkeleton sections={NEW_RECON_SHAPE} />;
}
