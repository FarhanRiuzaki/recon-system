import type { Metadata } from "next";
import { MembersPage } from "@/features/spaces/members-page";
import { guardedTitle, openSpace, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads, type SearchParams, toSearch } from "@/lib/server/prefetch";

type Params = Promise<{ spaceId: string }>;

/** Named after the space only for a caller who may open it (openSpace: membership through the API). */
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const space = await openSpace((await params).spaceId).catch(() => null);
  return guardedTitle(space ? `Members · ${space.name}` : "Page not found");
}

/** The space's layout (spaces/[spaceId]/layout.tsx) answers "Page not found" for a space the caller can't open. */
export default async function Page({ params, searchParams }: { params: Params; searchParams: Promise<SearchParams> }) {
  await requirePagePermission(null);
  const { spaceId } = await params;
  return <Prefetch reads={[reads.space(spaceId), reads.spaceMembers(spaceId, toSearch(await searchParams))]}><MembersPage id={spaceId} /></Prefetch>;
}
