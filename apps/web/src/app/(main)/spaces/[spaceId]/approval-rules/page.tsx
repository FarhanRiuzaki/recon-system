import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ApprovalRulesPage } from "@/features/approvals/rules-page";
import { guardedTitle, openSpace, requirePagePermission } from "@/lib/server/page-guard";
import { Prefetch, reads } from "@/lib/server/prefetch";

type Params = Promise<{ spaceId: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const space = await openSpace((await params).spaceId).catch(() => null);
  return guardedTitle(space?.roles.length ? `Approval rules · ${space.name}` : "Page not found");
}

/** A space's approval rules, one per change that needs approval (DEC-052 revision). */
export default async function Page({ params }: { params: Params }) {
  await requirePagePermission(null);
  const { spaceId } = await params;
  const space = await openSpace(spaceId);
  if (!space?.roles.length) notFound();
  return <Prefetch reads={[reads.space(spaceId), reads.approvalRules(spaceId)]}><ApprovalRulesPage spaceId={spaceId} spaceName={space.name} /></Prefetch>;
}
