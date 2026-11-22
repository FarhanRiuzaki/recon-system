import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { WORKFLOW_ACTIONS, WORKFLOW_ACTION_LABEL, type WorkflowAction } from "@starterkit/shared/workflows";
import { WorkflowEditor } from "@/features/approvals/workflow-editor";
import { guardedTitle, openSpace, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads } from "@/lib/server/prefetch";

type Params = Promise<{ spaceId: string; action: string }>;
const known = (a: string): a is WorkflowAction => (WORKFLOW_ACTIONS as readonly string[]).includes(a);

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { spaceId, action } = await params;
  const space = await openSpace(spaceId).catch(() => null);
  return guardedTitle(space?.roles.length && known(action) ? `${WORKFLOW_ACTION_LABEL[action]} workflow` : "Page not found");
}

/** One approval workflow of the space: its rules (a draft to edit, or the live version) beside Who approves. */
export default async function Page({ params }: { params: Params }) {
  await requirePagePermission(null);
  const { spaceId, action } = await params;
  const space = await openSpace(spaceId);
  if (!space?.roles.length || !known(action)) notFound();
  return <Prefetch reads={[reads.space(spaceId), reads.workflow(spaceId, action)]}><WorkflowEditor spaceId={spaceId} action={action} /></Prefetch>;
}
