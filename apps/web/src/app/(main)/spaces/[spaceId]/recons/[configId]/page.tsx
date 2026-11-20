import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReconDetail } from "@/features/recon/recon-detail";
import { RECON_TABS } from "@/features/recon/recon-text";
import { guardedTitle, openSpace, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads, reconSourceReads, type SearchParams, toSearch } from "@/lib/server/prefetch";

type Params = Promise<{ spaceId: string; configId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const space = await openSpace((await params).spaceId).catch(() => null);
  return guardedTitle(space?.roles.length ? "Recon" : "Page not found");
}

/**
 * A recon of the space: the builder over its open draft (Overview, with its sides' sources), its versions or its
 * activity (?tab=).
 */
export default async function Page({ params, searchParams }: { params: Params; searchParams: Promise<SearchParams> }) {
  await requirePagePermission(null);
  const { spaceId, configId } = await params;
  const space = await openSpace(spaceId);
  if (!space?.roles.length) notFound();
  const sp = toSearch(await searchParams);
  const tab = RECON_TABS.find((t) => t === sp.get("tab")) ?? "overview";
  const tables = tab === "versions" ? [reads.reconVersions(spaceId, configId, sp)] : tab === "activity" ? [reads.reconActivity(spaceId, configId, sp)]
    : await reconSourceReads(spaceId, configId);
  return (
    <Prefetch reads={[reads.space(spaceId), reads.recon(spaceId, configId), ...tables]}>
      <ReconDetail spaceId={spaceId} id={configId} tab={tab} />
    </Prefetch>
  );
}
