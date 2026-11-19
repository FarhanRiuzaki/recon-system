import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { EditSourceWizard } from "@/features/sources/wizard";
import { guardedTitle, openSpace, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads, type SearchParams, toSearch } from "@/lib/server/prefetch";

type Params = Promise<{ spaceId: string; sourceId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const space = await openSpace((await params).spaceId).catch(() => null);
  return guardedTitle(space?.roles.length ? "Edit source" : "Page not found");
}

/** The wizard over the source's open draft (`?step=1|2|3`; a config maker starts at 2). */
export default async function Page({ params, searchParams }: { params: Params; searchParams: Promise<SearchParams> }) {
  await requirePagePermission(null);
  const { spaceId, sourceId } = await params;
  const space = await openSpace(spaceId);
  if (!space?.roles.length) notFound();
  const step = Number(toSearch(await searchParams).get("step")) || null;
  return (
    <Prefetch reads={[reads.space(spaceId), reads.source(spaceId, sourceId)]}>
      <EditSourceWizard spaceId={spaceId} spaceName={space.name} id={sourceId} step={step} />
    </Prefetch>
  );
}
