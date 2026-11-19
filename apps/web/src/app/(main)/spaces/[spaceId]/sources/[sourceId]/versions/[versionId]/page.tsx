import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { VersionReview } from "@/features/sources/version-review";
import { guardedTitle, openSpace, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads } from "@/lib/server/prefetch";

type Params = Promise<{ spaceId: string; sourceId: string; versionId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const space = await openSpace((await params).spaceId).catch(() => null);
  return guardedTitle(space?.roles.length ? "Source version" : "Page not found");
}

/** A source version for any member of the space (a config checker decides on it); the source, the version and the viewer's roles are read here. */
export default async function Page({ params }: { params: Params }) {
  await requirePagePermission(null);
  const { spaceId, sourceId, versionId } = await params;
  const space = await openSpace(spaceId);
  if (!space?.roles.length) notFound();
  return (
    <Prefetch reads={[reads.space(spaceId), reads.source(spaceId, sourceId), reads.sourceVersion(spaceId, sourceId, versionId)]}>
      <VersionReview spaceId={spaceId} id={sourceId} versionId={versionId} />
    </Prefetch>
  );
}
