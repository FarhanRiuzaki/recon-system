import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { BreakPage } from "@/features/breaks/break-page";
import { guardedTitle, openSpace, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads, type SearchParams, toSearch } from "@/lib/server/prefetch";

type Params = Promise<{ spaceId: string; itemId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const space = await openSpace((await params).spaceId).catch(() => null);
  return guardedTitle(space?.roles.length ? "Break" : "Page not found");
}

/** One break of the space: the break, its counterparts (c.page) and its trail (a.page), read here. */
export default async function Page({ params, searchParams }: { params: Params; searchParams: Promise<SearchParams> }) {
  await requirePagePermission(null);
  const { spaceId, itemId } = await params;
  const space = await openSpace(spaceId);
  if (!space?.roles.length) notFound();
  const sp = toSearch(await searchParams);
  return (
    <Prefetch reads={[reads.space(spaceId), reads.break(spaceId, itemId), reads.breakCandidates(spaceId, itemId, sp), reads.breakActivity(spaceId, itemId, sp)]}>
      <BreakPage spaceId={spaceId} id={itemId} />
    </Prefetch>
  );
}
