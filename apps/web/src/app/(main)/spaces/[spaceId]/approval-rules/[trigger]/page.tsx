import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TRIGGER_LABEL, TRIGGERS, type Trigger } from "@starterkit/shared/workflows";
import { ApprovalRulesEditor } from "@/features/approvals/rules-editor";
import { guardedTitle, openSpace, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads } from "@/lib/server/prefetch";

type Params = Promise<{ spaceId: string; trigger: string }>;
const known = (t: string): t is Trigger => (TRIGGERS as readonly string[]).includes(t);

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { spaceId, trigger } = await params;
  const space = await openSpace(spaceId).catch(() => null);
  return guardedTitle(space?.roles.length && known(trigger) ? `${TRIGGER_LABEL[trigger]} approval rules` : "Page not found");
}

/** One trigger's approval rules in the space: rules that pick library workflows (a draft to edit, or the live version) beside Who approves. */
export default async function Page({ params }: { params: Params }) {
  await requirePagePermission(null);
  const { spaceId, trigger } = await params;
  const space = await openSpace(spaceId);
  if (!space?.roles.length || !known(trigger)) notFound();
  return <Prefetch reads={[reads.space(spaceId), reads.approvalRulesDetail(spaceId, trigger)]}><ApprovalRulesEditor spaceId={spaceId} trigger={trigger} /></Prefetch>;
}
