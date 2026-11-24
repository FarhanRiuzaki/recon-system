import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LibraryEditor } from "@/features/approvals/library-editor";
import { guardedTitle, openSpace, requirePagePermission, workflowAccess } from "@/lib/server/page-guard";
import { Prefetch, reads } from "@/lib/server/prefetch";

type Params = Promise<{ spaceId: string; id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { perms } = await requirePagePermission(null);
  const space = await openSpace((await params).spaceId).catch(() => null);
  return guardedTitle(workflowAccess(space, perms).read ? "Workflow" : "Page not found");
}

/**
 * One workflow of a space: its chain (a draft to edit, or the live version) beside the recons that use it. Opens for
 * whoever reads the space's workflows (workflowAccess: a member or `workflow.view`); the API's `canEdit` says who edits.
 */
export default async function Page({ params }: { params: Params }) {
  const { perms } = await requirePagePermission(null);
  const { spaceId, id } = await params;
  if (!workflowAccess(await openSpace(spaceId), perms).read) notFound();
  return <Prefetch reads={[reads.space(spaceId), reads.spaceWorkflow(spaceId, id)]}><LibraryEditor spaceId={spaceId} id={id} /></Prefetch>;
}
