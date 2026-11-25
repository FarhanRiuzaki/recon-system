import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { VersionPage } from "@/features/reports/version-page";
import { guardedTitle, openSpace, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads } from "@/lib/server/prefetch";

type Params = Promise<{ spaceId: string; templateId: string; versionId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const space = await openSpace((await params).spaceId).catch(() => null);
  return guardedTitle(space?.roles.length ? `Report version · ${space.name}` : "Page not found");
}

export default async function Page({ params }: { params: Params }) {
  await requirePagePermission(null);
  const { spaceId, templateId, versionId } = await params;
  const space = await openSpace(spaceId);
  if (!space?.roles.length) notFound();
  return <Prefetch reads={[reads.space(spaceId), reads.reportTemplate(spaceId, templateId), reads.reportVersions(spaceId, templateId)]}><VersionPage spaceId={spaceId} templateId={templateId} versionId={versionId} /></Prefetch>;
}
