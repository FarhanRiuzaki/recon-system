import { RouteSkeleton } from "@/components/route-skeleton";
import { TODAY_SHAPE } from "@/features/recon/shapes";

export default function Loading() {
  return <RouteSkeleton sections={TODAY_SHAPE} />;
}
