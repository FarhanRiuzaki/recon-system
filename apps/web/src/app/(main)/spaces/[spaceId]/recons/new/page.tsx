import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { NewRecon } from "@/features/recon/new-recon";
import { guardedTitle, openSpace, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads } from "@/lib/server/prefetch";

type Params = Promise<{ spaceId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const space = await openSpace((await params).spaceId).catch(() => null);
  return guardedTitle(space?.roles.length ? "New recon" : "Page not found");
}

/** A config maker's new recon (the screen says why to anyone else in the space); members only, like every recon page. */
export default async function Page({ params }: { params: Params }) {
  await requirePagePermission(null);
  const { spaceId } = await params;
  const space = await openSpace(spaceId);
  if (!space?.roles.length) notFound();
  return <Prefetch reads={[reads.space(spaceId), reads.sideSourceOptions(spaceId)]}><NewRecon spaceId={spaceId} /></Prefetch>;
}
