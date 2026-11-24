import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LibraryPage } from "@/features/approvals/library-page";
import { guardedTitle, openSpace, requirePagePermission, workflowAccess } from "@/lib/server/page-guard";
import { Prefetch, reads, type SearchParams, toSearch } from "@/lib/server/prefetch";

type Params = Promise<{ spaceId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { perms } = await requirePagePermission(null);
  const space = await openSpace((await params).spaceId).catch(() => null);
  if (!workflowAccess(space, perms).read) return guardedTitle("Page not found");
  return guardedTitle(space ? `Workflows · ${space.name}` : "Workflows");
}

/**
 * A space's workflows (DEC-052 rev 2), as the API's guards allow: any role of the space or `workflow.view` reads (a
 * holder who is no member too); a space admin or `workflow.manage` edits (workflowAccess).
 */
export default async function Page({ params, searchParams }: { params: Params; searchParams: Promise<SearchParams> }) {
  const { perms } = await requirePagePermission(null);
  const { spaceId } = await params;
  const space = await openSpace(spaceId);
  const access = workflowAccess(space, perms);
  if (!access.read) notFound();
  return (
    <Prefetch reads={[reads.space(spaceId), reads.workflows(spaceId, toSearch(await searchParams))]}>
      <LibraryPage spaceId={spaceId} spaceName={space?.name ?? null} canManage={access.manage} />
    </Prefetch>
  );
}
