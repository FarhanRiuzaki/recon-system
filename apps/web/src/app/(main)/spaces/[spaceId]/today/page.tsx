import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TodayPage } from "@/features/recon/today-page";
import { guardedTitle, openSpace, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads } from "@/lib/server/prefetch";

type Params = Promise<{ spaceId: string }>;

/** Named after the space only for a member (openSpace: through the API; Today is a member's data). */
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const space = await openSpace((await params).spaceId).catch(() => null);
  return guardedTitle(space?.roles.length ? `Today · ${space.name}` : "Page not found");
}

/** The space's layout answers "Page not found" for a space the caller can't open; a space.view holder who is no member gets it here. */
export default async function Page({ params }: { params: Params }) {
  await requirePagePermission(null);
  const { spaceId } = await params;
  const space = await openSpace(spaceId);
  if (!space?.roles.length) notFound();
  return <Prefetch reads={[reads.spaceToday(spaceId)]}><TodayPage spaceId={spaceId} spaceName={space.name} /></Prefetch>;
}
