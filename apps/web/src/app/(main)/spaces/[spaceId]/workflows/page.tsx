import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LibraryPage } from "@/features/approvals/library-page";
import { guardedTitle, openSpace, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads, type SearchParams, toSearch } from "@/lib/server/prefetch";

type Params = Promise<{ spaceId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const space = await openSpace((await params).spaceId).catch(() => null);
  return guardedTitle(space?.roles.length ? `Workflows · ${space.name}` : "Page not found");
}

/** A space's workflows (DEC-052 rev 2): any role of the space reads; a space admin or a workflow manager edits. */
export default async function Page({ params, searchParams }: { params: Params; searchParams: Promise<SearchParams> }) {
  const { perms } = await requirePagePermission(null);
  const { spaceId } = await params;
  const space = await openSpace(spaceId);
  if (!space?.roles.length) notFound();
  const canManage = perms.includes("workflow.manage") || space.roles.includes("space_admin");
  return (
    <Prefetch reads={[reads.space(spaceId), reads.workflows(spaceId, toSearch(await searchParams))]}>
      <LibraryPage spaceId={spaceId} spaceName={space.name} canManage={canManage} />
    </Prefetch>
  );
}
