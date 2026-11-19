import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NewSourceWizard } from "@/features/sources/wizard";
import { guardedTitle, openSpace, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads } from "@/lib/server/prefetch";

type Params = Promise<{ spaceId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const space = await openSpace((await params).spaceId).catch(() => null);
  return guardedTitle(space?.roles.length ? "New source" : "Page not found");
}

/** A source admin's new source (the screen says why to anyone else in the space); members only, like every source page. */
export default async function Page({ params }: { params: Params }) {
  await requirePagePermission(null);
  const { spaceId } = await params;
  const space = await openSpace(spaceId);
  if (!space?.roles.length) notFound();
  return <Prefetch reads={[reads.space(spaceId)]}><NewSourceWizard spaceId={spaceId} spaceName={space.name} /></Prefetch>;
}
