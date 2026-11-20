import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReconRunPage } from "@/features/recon/run-page";
import { guardedTitle, openSpace, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads, reconRunReads, type SearchParams, toSearch } from "@/lib/server/prefetch";

type Params = Promise<{ spaceId: string; configId: string; runId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const space = await openSpace((await params).spaceId).catch(() => null);
  return guardedTitle(space?.roles.length ? "Recon results" : "Page not found");
}

/** A run of a recon (a draft's simulation or a run of the published version) for any member of the space: its results per pass. */
export default async function Page({ params, searchParams }: { params: Params; searchParams: Promise<SearchParams> }) {
  await requirePagePermission(null);
  const { spaceId, configId, runId } = await params;
  const space = await openSpace(spaceId);
  if (!space?.roles.length) notFound();
  const run = await reconRunReads(spaceId, configId, runId, toSearch(await searchParams));
  return (
    <Prefetch reads={[reads.space(spaceId), reads.recon(spaceId, configId), ...run]}>
      <ReconRunPage spaceId={spaceId} id={configId} runId={runId} />
    </Prefetch>
  );
}
