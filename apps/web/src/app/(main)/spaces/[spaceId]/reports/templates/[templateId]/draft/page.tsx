import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DraftWizard } from "@/features/reports/draft-wizard";
import { guardedTitle, openSpace, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads, type SearchParams, toSearch } from "@/lib/server/prefetch";

type Params = Promise<{ spaceId: string; templateId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const space = await openSpace((await params).spaceId).catch(() => null);
  return guardedTitle(space?.roles.length ? `Report draft · ${space.name}` : "Page not found");
}

export default async function Page({ params, searchParams }: { params: Params; searchParams: Promise<SearchParams> }) {
  await requirePagePermission(null);
  const { spaceId, templateId } = await params;
  const space = await openSpace(spaceId);
  if (!space?.roles.length) notFound();
  const version = toSearch(await searchParams).get("version");
  return <Prefetch reads={[reads.space(spaceId), reads.reportTemplate(spaceId, templateId), reads.reportVersions(spaceId, templateId)]}><DraftWizard spaceId={spaceId} templateId={templateId} versionId={version} /></Prefetch>;
}
