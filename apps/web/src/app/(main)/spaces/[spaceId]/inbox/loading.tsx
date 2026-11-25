import { RouteSkeleton } from "@/components/route-skeleton";
import { INBOX_SHAPE } from "@/features/inbox/shapes";

export default function Loading() {
  return <RouteSkeleton sections={INBOX_SHAPE} />;
}
