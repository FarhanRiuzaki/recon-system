import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReconSetup } from "@/features/recon/recon-setup";
import { guardedTitle, openSpace, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads, reconSourceReads, type SearchParams, toSearch } from "@/lib/server/prefetch";

type Params = Promise<{ spaceId: string; configId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const space = await openSpace((await params).spaceId).catch(() => null);
  return guardedTitle(space?.roles.length ? "Edit recon" : "Page not found");
}

/** The setup over the recon's open draft (`?step=1…5`: Sources, Matching, Schedule, Test, Review and submit). */
export default async function Page({ params, searchParams }: { params: Params; searchParams: Promise<SearchParams> }) {
  await requirePagePermission(null);
  const { spaceId, configId } = await params;
  const space = await openSpace(spaceId);
  if (!space?.roles.length) notFound();
  const step = Number(toSearch(await searchParams).get("step")) || null;
  const sources = await reconSourceReads(spaceId, configId);
  return (
    <Prefetch reads={[reads.space(spaceId), reads.recon(spaceId, configId), reads.sideSourceOptions(spaceId), ...sources]}>
      <ReconSetup spaceId={spaceId} id={configId} step={step} />
    </Prefetch>
  );
}
