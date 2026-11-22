import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReconDetail } from "@/features/recon/recon-detail";
import { reconTabOf } from "@/features/recon/recon-text";
import { guardedTitle, openSpace, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads, reconSourceReads, type SearchParams, toSearch } from "@/lib/server/prefetch";

type Params = Promise<{ spaceId: string; configId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const space = await openSpace((await params).spaceId).catch(() => null);
  return guardedTitle(space?.roles.length ? "Recon" : "Page not found");
}

/**
 * A recon of the space (?tab=): Overview (its day, runs, trend), Configuration (the builder over its open draft, with its
 * sides' sources, else the published spec), History (versions and activity).
 */
export default async function Page({ params, searchParams }: { params: Params; searchParams: Promise<SearchParams> }) {
  await requirePagePermission(null);
  const { spaceId, configId } = await params;
  const space = await openSpace(spaceId);
  if (!space?.roles.length) notFound();
  const sp = toSearch(await searchParams);
  const tab = reconTabOf(sp.get("tab"));
  const tables = tab === "overview" ? [reads.reconLive(spaceId, configId), reads.reconTrend(spaceId, configId), reads.reconRunsFirst(spaceId, configId), reads.sideSourceOptions(spaceId)]
    : tab === "history" ? [reads.reconVersions(spaceId, configId, sp), reads.reconActivity(spaceId, configId, sp)]
    : await reconSourceReads(spaceId, configId);
  return (
    <Prefetch reads={[reads.space(spaceId), reads.recon(spaceId, configId), ...tables]}>
      <ReconDetail spaceId={spaceId} id={configId} tab={tab} />
    </Prefetch>
  );
}
