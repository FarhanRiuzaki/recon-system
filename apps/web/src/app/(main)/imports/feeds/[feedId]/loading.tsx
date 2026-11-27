import { RouteSkeleton } from "@/components/route-skeleton";
import { FEED_FORM_SHAPE } from "@/features/imports/shapes";

/** Loading shape of /imports/feeds/[feedId]: the same sections the screen shows while its data loads. */
export default function Loading() {
  return <RouteSkeleton sections={FEED_FORM_SHAPE} />;
}
