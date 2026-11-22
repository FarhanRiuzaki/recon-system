import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { WorkflowsPage } from "@/features/approvals/workflows-page";
import { guardedTitle, openSpace, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads } from "@/lib/server/prefetch";

type Params = Promise<{ spaceId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const space = await openSpace((await params).spaceId).catch(() => null);
  return guardedTitle(space?.roles.length ? `Workflows · ${space.name}` : "Page not found");
}

/** A space's approval workflows, one per action that needs approval (DEC-052). */
export default async function Page({ params }: { params: Params }) {
  await requirePagePermission(null);
  const { spaceId } = await params;
  const space = await openSpace(spaceId);
  if (!space?.roles.length) notFound();
  return <Prefetch reads={[reads.space(spaceId), reads.workflows(spaceId)]}><WorkflowsPage spaceId={spaceId} spaceName={space.name} /></Prefetch>;
}
