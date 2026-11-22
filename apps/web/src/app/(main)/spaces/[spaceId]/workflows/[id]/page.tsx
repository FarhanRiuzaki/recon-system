import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { LibraryEditor } from "@/features/approvals/library-editor";
import { guardedTitle, openSpace, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads } from "@/lib/server/prefetch";

type Params = Promise<{ spaceId: string; id: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const space = await openSpace((await params).spaceId).catch(() => null);
  return guardedTitle(space?.roles.length ? "Workflow" : "Page not found");
}

/** One workflow of a space: its chain (a draft to edit, or the live version) beside the recons that use it. */
export default async function Page({ params }: { params: Params }) {
  await requirePagePermission(null);
  const { spaceId, id } = await params;
  const space = await openSpace(spaceId);
  if (!space?.roles.length) notFound();
  return <Prefetch reads={[reads.space(spaceId), reads.spaceWorkflow(spaceId, id)]}><LibraryEditor spaceId={spaceId} id={id} /></Prefetch>;
}
