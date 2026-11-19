import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SourceDetail } from "@/features/sources/source-detail";
import { guardedTitle, openSpace, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads, type SearchParams, toSearch } from "@/lib/server/prefetch";

type Params = Promise<{ spaceId: string; sourceId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const space = await openSpace((await params).spaceId).catch(() => null);
  return guardedTitle(space?.roles.length ? "Source" : "Page not found");
}

/**
 * A source of the space, or one shared to it. The kind decides the first table, which the server can't know before the
 * source answers, so the files and the snapshots are both read with it (one is empty); the Quarantine tab reads its own.
 */
export default async function Page({ params, searchParams }: { params: Params; searchParams: Promise<SearchParams> }) {
  await requirePagePermission(null);
  const { spaceId, sourceId } = await params;
  const space = await openSpace(spaceId);
  if (!space?.roles.length) notFound();
  const sp = toSearch(await searchParams);
  const tab = sp.get("tab") === "quarantine" ? "quarantine" : "overview";
  const tables = tab === "quarantine"
    ? [reads.sourceQuarantine(spaceId, sourceId, sp)]
    : [reads.sourceFiles(spaceId, sourceId, sp), reads.sourceSnapshots(spaceId, sourceId, sp)];
  return (
    <Prefetch reads={[reads.space(spaceId), reads.source(spaceId, sourceId), ...tables]}>
      <SourceDetail spaceId={spaceId} id={sourceId} tab={tab} />
    </Prefetch>
  );
}
