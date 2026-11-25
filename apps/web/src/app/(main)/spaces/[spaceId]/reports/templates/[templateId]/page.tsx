import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TemplatePage } from "@/features/reports/template-page";
import { guardedTitle, openSpace, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads } from "@/lib/server/prefetch";

type Params = Promise<{ spaceId: string; templateId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const space = await openSpace((await params).spaceId).catch(() => null);
  return guardedTitle(space?.roles.length ? `Report template · ${space.name}` : "Page not found");
}

export default async function Page({ params }: { params: Params }) {
  await requirePagePermission(null);
  const { spaceId, templateId } = await params;
  const space = await openSpace(spaceId);
  if (!space?.roles.length) notFound();
  return <Prefetch reads={[reads.space(spaceId), reads.reportTemplate(spaceId, templateId), reads.reportVersions(spaceId, templateId)]}><TemplatePage spaceId={spaceId} templateId={templateId} /></Prefetch>;
}
