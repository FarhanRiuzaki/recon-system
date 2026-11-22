import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PostingPage } from "@/features/integrations/posting-page";
import { guardedTitle, openSpace, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads, type SearchParams, toSearch } from "@/lib/server/prefetch";

type Params = Promise<{ spaceId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const space = await openSpace((await params).spaceId).catch(() => null);
  return guardedTitle(space?.roles.length ? `Posting · ${space.name}` : "Page not found");
}

/** What the space's approvals sent to the bank (stage 4): any role of the space reads. */
export default async function Page({ params, searchParams }: { params: Params; searchParams: Promise<SearchParams> }) {
  await requirePagePermission(null);
  const { spaceId } = await params;
  const space = await openSpace(spaceId);
  if (!space?.roles.length) notFound();
  return <Prefetch reads={[reads.space(spaceId), reads.actionRuns(spaceId, toSearch(await searchParams))]}><PostingPage spaceId={spaceId} /></Prefetch>;
}
