import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReportsPage } from "@/features/reports/reports-page";
import { guardedTitle, openSpace, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads, type SearchParams, toSearch } from "@/lib/server/prefetch";

type Params = Promise<{ spaceId: string }>;

/** Named after the space only for a member (reports are a member's data). */
export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const space = await openSpace((await params).spaceId).catch(() => null);
  return guardedTitle(space?.roles.length ? `Reports · ${space.name}` : "Page not found");
}

/** The space's report files, the first page prefetched. */
export default async function Page({ params, searchParams }: { params: Params; searchParams: Promise<SearchParams> }) {
  await requirePagePermission(null);
  const { spaceId } = await params;
  const space = await openSpace(spaceId);
  if (!space?.roles.length) notFound();
  const sp = toSearch(await searchParams);
  return <Prefetch reads={[reads.space(spaceId), reads.reportFiles(spaceId, sp)]}><ReportsPage spaceId={spaceId} /></Prefetch>;
}
