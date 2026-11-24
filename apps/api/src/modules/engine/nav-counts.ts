// GET /v1/spaces/:spaceId/nav-counts: the sidebar's three numbers, each the count its screen shows on the same data
// (the Unmatch list's total, the approvals inbox's "Waiting for me", Today's postings needing attention), in one
// withSpace under the viewer (RLS), each stopped at NAV_COUNT_CAP.
import type { NavCountsDto } from "@starterkit/shared/contracts/recon";
import { NAV_COUNT_CAP } from "@starterkit/shared/spaces";
import { waitingCount } from "../approvals";
import type { Ctx } from "../auth";
import { postingAttention } from "../integrations";
import { withSpace } from "../spaces";
import { openBreakCount } from "./break-queue";

export function navCounts(ctx: Ctx, now = new Date()): Promise<NavCountsDto> {
  const spaceId = ctx.space!.id;
  return withSpace({ spaceIds: [spaceId], userId: ctx.user.id }, async (tx) => {
    const unmatch = await openBreakCount(tx, ctx, spaceId, NAV_COUNT_CAP, now);
    const waiting = await waitingCount(tx, ctx, NAV_COUNT_CAP);
    const posting = (await postingAttention(tx, spaceId, now)).reduce((n, p) => n + p.failed + p.timeout + p.notSent, 0);
    const cap = (n: number) => Math.min(n, NAV_COUNT_CAP);
    return {
      unmatch: cap(unmatch), approvals: cap(waiting.n), posting: cap(posting),
      capped: waiting.capped || [unmatch, waiting.n, posting].some((n) => n > NAV_COUNT_CAP),
    };
  });
}
