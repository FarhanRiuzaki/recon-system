import { RouteSkeleton } from "@/components/route-skeleton";
import { FEED_FORM_SHAPE } from "@/features/imports/shapes";

/** Loading shape of /imports/feeds/new. */
export default function Loading() {
  return <RouteSkeleton sections={FEED_FORM_SHAPE} />;
}
