import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReconsPage } from "@/features/recon/recons-page";
import { guardedTitle, openSpace, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads, type SearchParams, toSearch } from "@/lib/server/prefetch";

type Params = Promise<{ spaceId: string }>;

/** Named after the space only for a member (openSpace: through the API; recons are a member's data). */
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const space = await openSpace((await params).spaceId).catch(() => null);
  return guardedTitle(space?.roles.length ? `Recons · ${space.name}` : "Page not found");
}

/** The space's layout answers "Page not found" for a space the caller can't open; a space.view holder who is no member gets it here. */
export default async function Page({ params, searchParams }: { params: Params; searchParams: Promise<SearchParams> }) {
  await requirePagePermission(null);
  const { spaceId } = await params;
  const space = await openSpace(spaceId);
  if (!space?.roles.length) notFound();
  // the viewer's roles in the space (New recon is a config maker's) come with the first page
  return <Prefetch reads={[reads.space(spaceId), reads.recons(spaceId, toSearch(await searchParams))]}><ReconsPage spaceId={spaceId} spaceName={space.name} /></Prefetch>;
}
