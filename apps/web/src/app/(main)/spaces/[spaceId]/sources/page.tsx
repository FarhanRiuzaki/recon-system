import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SourcesPage } from "@/features/sources/sources-page";
import { guardedTitle, openSpace, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads, type SearchParams, toSearch } from "@/lib/server/prefetch";

type Params = Promise<{ spaceId: string }>;

/** Named after the space only for a member (openSpace: through the API; sources are a member's data). */
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const space = await openSpace((await params).spaceId).catch(() => null);
  return guardedTitle(space?.roles.length ? `Sources · ${space.name}` : "Page not found");
}

/** The space's layout answers "Page not found" for a space the caller can't open; a space.view holder who is no member gets it here. */
export default async function Page({ params, searchParams }: { params: Params; searchParams: Promise<SearchParams> }) {
  await requirePagePermission(null);
  const { spaceId } = await params;
  const space = await openSpace(spaceId);
  if (!space?.roles.length) notFound();
  return <Prefetch reads={[reads.sources(spaceId, toSearch(await searchParams))]}><SourcesPage spaceId={spaceId} spaceName={space.name} /></Prefetch>;
}
