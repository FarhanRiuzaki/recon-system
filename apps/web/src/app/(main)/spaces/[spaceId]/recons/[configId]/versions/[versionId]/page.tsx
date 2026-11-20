import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ReconVersionReview } from "@/features/recon/version-review";
import { guardedTitle, openSpace, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads, reconSourceReads } from "@/lib/server/prefetch";

type Params = Promise<{ spaceId: string; configId: string; versionId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const space = await openSpace((await params).spaceId).catch(() => null);
  return guardedTitle(space?.roles.length ? "Recon version" : "Page not found");
}

/** A recon version for any member of the space (a config checker decides on it); the recon, the version, its sides' sources and the viewer's roles are read here. */
export default async function Page({ params }: { params: Params }) {
  await requirePagePermission(null);
  const { spaceId, configId, versionId } = await params;
  const space = await openSpace(spaceId);
  if (!space?.roles.length) notFound();
  const sources = await reconSourceReads(spaceId, configId, versionId);
  return (
    <Prefetch reads={[reads.space(spaceId), reads.recon(spaceId, configId), reads.reconVersion(spaceId, configId, versionId), ...sources]}>
      <ReconVersionReview spaceId={spaceId} id={configId} versionId={versionId} />
    </Prefetch>
  );
}
