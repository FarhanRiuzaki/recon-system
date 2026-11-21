import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SourceDetail } from "@/features/sources/source-detail";
import { SOURCE_TABS } from "@/features/sources/source-text";
import { guardedTitle, openSpace, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads, type SearchParams, toSearch } from "@/lib/server/prefetch";

type Params = Promise<{ spaceId: string; sourceId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const space = await openSpace((await params).spaceId).catch(() => null);
  return guardedTitle(space?.roles.length ? "Source" : "Page not found");
}

/**
 * A source of the space, or one shared to it. What renders depends on the source (its kind decides the Overview's
 * table; a shared one has no Quarantine tab and shows the Overview even at ?tab=quarantine), which the server can't
 * know before the source answers: so the files and the snapshots are always read with it, and the quarantine too at
 * ?tab=quarantine (a shared source answers it 404, left out), and the tab's own list at ?tab=records|versions|activity. Nothing
 * the screen renders is fetched after hydration.
 */
export default async function Page({ params, searchParams }: { params: Params; searchParams: Promise<SearchParams> }) {
  await requirePagePermission(null);
  const { spaceId, sourceId } = await params;
  const space = await openSpace(spaceId);
  if (!space?.roles.length) notFound();
  const sp = toSearch(await searchParams);
  const tab = SOURCE_TABS.find((t) => t === sp.get("tab")) ?? "overview";
  const tables = [
    reads.sourceFiles(spaceId, sourceId, sp), reads.sourceSnapshots(spaceId, sourceId, sp),
    // the Pull history card's first page (a watermark source's; any other answers an empty page)
    ...(tab === "overview" ? [reads.sourcePulls(spaceId, sourceId)] : []),
    ...(tab === "records" ? [reads.sourceRecords(spaceId, sourceId, sp)] : []),
    ...(tab === "quarantine" ? [reads.sourceQuarantine(spaceId, sourceId, sp)] : []),
    ...(tab === "versions" ? [reads.sourceVersions(spaceId, sourceId, sp)] : []),
    ...(tab === "activity" ? [reads.sourceActivity(spaceId, sourceId, sp)] : []),
  ];
  return (
    <Prefetch reads={[reads.space(spaceId), reads.source(spaceId, sourceId), ...tables]}>
      <SourceDetail spaceId={spaceId} id={sourceId} tab={tab} />
    </Prefetch>
  );
}
