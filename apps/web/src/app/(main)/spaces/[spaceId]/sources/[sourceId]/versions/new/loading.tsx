import { RouteSkeleton } from "@/components/route-skeleton";
import { WIZARD_SHAPE } from "@/features/sources/shapes";

/** Loading shape of the source wizard (WIZARD_SHAPE). */
export default function Loading() {
  return <RouteSkeleton sections={WIZARD_SHAPE} />;
}
