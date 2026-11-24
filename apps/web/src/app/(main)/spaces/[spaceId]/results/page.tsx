import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import type { Page as Paged } from "@starterkit/shared/contracts/common";
import type { ReconRowDto } from "@starterkit/shared/contracts/recon";
import { ResultsPage } from "@/features/results/results-page";
import { pickRecon } from "@/features/results/result-model";
import { backendJson, v1Path } from "@/lib/server/backend";
import { guardedTitle, openSpace, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads, type SearchParams, toSearch } from "@/lib/server/prefetch";
import { getSession } from "@/lib/server/session";
import { reconOptions } from "@/lib/shared/queries-recon";

type Params = Promise<{ spaceId: string }>;

/** Named after the space only for a member (openSpace: through the API; results are a member's data). */
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const space = await openSpace((await params).spaceId).catch(() => null);
  return guardedTitle(space?.roles.length ? `Operation result · ${space.name}` : "Page not found");
}

/**
 * One recon at a time (`?recon=`): without one, or with one that has no published version, the first recon by name
 * that has one, so the URL always names the recon the table shows. No such recon: the screen's empty state.
 */
export default async function Page({ params, searchParams }: { params: Params; searchParams: Promise<SearchParams> }) {
  await requirePagePermission(null);
  const { spaceId } = await params;
  const space = await openSpace(spaceId);
  if (!space?.roles.length) notFound();
  const sp = toSearch(await searchParams);
  const { token } = await getSession();
  const { data } = await backendJson<Paged<ReconRowDto>>(v1Path(reconOptions(spaceId).url)!, { token, req: { headers: await headers() } });
  const configId = pickRecon(data?.items ?? [], sp.get("recon"));
  if (configId && configId !== sp.get("recon")) {
    sp.set("recon", configId);
    redirect(`/spaces/${encodeURIComponent(spaceId)}/results?${sp}`);
  }
  const rs = [reads.space(spaceId), reads.reconOptions(spaceId), ...(configId ? [reads.recon(spaceId, configId), reads.resultColumns(spaceId, configId), reads.results(spaceId, configId, sp)] : [])];
  return <Prefetch reads={rs}><ResultsPage spaceId={spaceId} /></Prefetch>;
}
