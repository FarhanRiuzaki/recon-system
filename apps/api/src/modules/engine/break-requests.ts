// A change of a break a checker decides (Plan 5 Task 3, spec §11 maker-checker): a force match (sides that total
// differently), unmatch (a break's match undone, its items back in the queue), write-off. Whoever may work the break
// asks, with a note; a reviewer or space admin who didn't ask approves (the change happens then, by them) or rejects
// with a note (the break goes back where it stood). A Superadmin decides anything, its own requests too (DEC-051).
// One pending request per break (approval_requests_one_pending). Every write-off needs approval: the per-space
// threshold under which one wouldn't (spec §11, bank data) is not set in phase 1 yet.
import type { ApproveRequestBody, BreakDetailDto, RejectRequestBody, RequestBreakBody } from "@starterkit/shared/contracts/breaks";
import { requestBlocked } from "@starterkit/shared/approvals";
import { isSuperadmin } from "@starterkit/shared/permissions";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { InTx } from "../../kernel/db";
import { ApiError, isUniqueViolation } from "../../kernel/errors";
import { recordActivity } from "../audit";
import type { Ctx } from "../auth";
import { breakDetail, breakOf, inSpace, isLead, itemsOf, matchIn, matchItems, mayTouch, mayWork } from "./break-resolve";
import { approvalRequests, matchGroups, matchMembers, reconItems } from "./schema";
import { assertNotSigned } from "./signoff";

/** The group the break is matched in now (not reversed). */
async function groupOf(tx: InTx, spaceId: string, itemId: string) {
  const [g] = await tx.select({ id: matchGroups.id }).from(matchMembers)
    .innerJoin(matchGroups, and(eq(matchGroups.spaceId, matchMembers.spaceId), eq(matchGroups.id, matchMembers.groupId)))
    .where(and(eq(matchMembers.spaceId, spaceId), eq(matchMembers.itemId, itemId), isNull(matchGroups.reversedBy), isNull(matchGroups.simRunId))).limit(1);
  return g ?? null;
}

/** POST …/breaks/{itemId}/request. */
export async function requestChange(ctx: Ctx, id: string, b: RequestBreakBody): Promise<BreakDetailDto> {
  await inSpace(ctx, async (tx, spaceId) => {
    const x = await breakOf(tx, spaceId, id);
    const [locked] = await tx.select({ v: reconItems.version }).from(reconItems)
      .where(and(eq(reconItems.spaceId, spaceId), eq(reconItems.id, x.id), eq(reconItems.businessDate, x.businessDate))).for("update");
    if (locked?.v !== x.version) throw new ApiError("invalid_state", "This break changed meanwhile. Reload it and try again.");
    await assertNotSigned(tx, spaceId, x.configId, [x.businessDate]);
    let itemIds: string[] = [];
    if (b.kind === "unmatch") {
      mayTouch(ctx, x);
      if (x.status !== "matched" || !(await groupOf(tx, spaceId, x.id))) throw new ApiError("invalid_state", "This break isn't matched, so there is nothing to undo.");
    } else {
      mayWork(ctx, x);
      if (b.kind === "force_match") {
        const m = await matchItems(tx, spaceId, x, b.itemIds);
        if (m.mixed) throw new ApiError("bad_request", m.mixed);
        if (!m.differ) throw new ApiError("invalid_state", "These totals agree: match them without approval.");
        itemIds = m.ids.slice(1);
      }
    }
    const [item] = await itemsOf(tx, spaceId, [x.id]);
    const rid = Bun.randomUUIDv7();
    try {
      await tx.insert(approvalRequests).values({
        id: rid, spaceId, configId: x.configId, kind: b.kind, itemId: x.id, itemIds, label: item?.ref ?? "Break", note: b.note,
        prevState: x.breakState, requestedBy: ctx.user.id,
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new ApiError("invalid_state", "A change of this break already waits for a checker's decision.");
      throw e;
    }
    // a break waiting for a force match or write-off leaves the work states (a matched one keeps resolved meanwhile)
    if (b.kind !== "unmatch") {
      await tx.update(reconItems).set({ breakState: "pending_approval", version: sql`${reconItems.version} + 1`, stateAt: sql`now()` })
        .where(and(eq(reconItems.spaceId, spaceId), eq(reconItems.id, x.id), eq(reconItems.businessDate, x.businessDate)));
    }
    await recordActivity(tx, ctx, {
      action: "break.request", target: { type: "break", id: x.id, label: item?.ref ?? "Break" },
      before: { state: x.breakState ?? "new" }, after: { kind: b.kind, note: b.note, ...(itemIds.length ? { items: itemIds.length } : {}) },
    });
  });
  return breakDetail(ctx, id);
}

/** The pending request of the break, locked; the caller must be a checker who didn't ask (or a Superadmin). */
async function pendingFor(tx: InTx, ctx: Ctx, spaceId: string, itemId: string) {
  const [rq] = await tx.select().from(approvalRequests)
    .where(and(eq(approvalRequests.spaceId, spaceId), eq(approvalRequests.itemId, itemId), eq(approvalRequests.status, "pending"))).for("update");
  if (!rq) throw new ApiError("invalid_state", "Nothing of this break waits for a decision.");
  const why = requestBlocked(rq.requestedBy, ctx.user.id, isLead(ctx), isSuperadmin(ctx.user.roles));
  if (why) throw new ApiError(rq.requestedBy === ctx.user.id ? "self_approval" : "forbidden", why);
  return rq;
}
const decided = (ctx: Ctx, status: "approved" | "rejected", note?: string) =>
  ({ status, decidedBy: ctx.user.id, decidedAt: sql`now()`, decisionNote: note ?? null });

/** POST …/breaks/{itemId}/request/approve: the change happens now, by the checker. */
export async function approveRequest(ctx: Ctx, id: string, b: ApproveRequestBody): Promise<BreakDetailDto> {
  await inSpace(ctx, async (tx, spaceId) => {
    const x = await breakOf(tx, spaceId, id);
    const rq = await pendingFor(tx, ctx, spaceId, x.id);
    const extra = { kind: rq.kind, requestedBy: rq.requestedBy, ...(b.note ? { decisionNote: b.note } : {}) };
    if (rq.kind === "force_match") {
      await matchIn(tx, ctx, spaceId, x, rq.itemIds, { note: rq.note, checkTotals: false, resolution: "FORCE_MATCHED", action: "break.approve", extra });
    } else if (rq.kind === "write_off") {
      await assertNotSigned(tx, spaceId, x.configId, [x.businessDate]);
      const [locked] = await tx.select({ v: reconItems.version, status: reconItems.status }).from(reconItems)
        .where(and(eq(reconItems.spaceId, spaceId), eq(reconItems.id, x.id), eq(reconItems.businessDate, x.businessDate))).for("update");
      if (locked?.status !== "break") throw new ApiError("invalid_state", "This break changed meanwhile. Reject the request and ask again.");
      await tx.update(reconItems).set({ status: "closed", breakState: "resolved", resolution: "WRITTEN_OFF", version: sql`${reconItems.version} + 1`, stateAt: sql`now()` })
        .where(and(eq(reconItems.spaceId, spaceId), eq(reconItems.id, x.id), eq(reconItems.businessDate, x.businessDate)));
      await recordActivity(tx, ctx, { action: "break.approve", target: { type: "break", id: x.id, label: rq.label }, before: { state: x.breakState }, after: { resolution: "WRITTEN_OFF", note: rq.note, ...extra } });
    } else {
      // unmatch: the group reversed by the checker; each member back where a run left it (a break in the queue again,
      // with whoever had it; an item that never broke open for the next run)
      const g = await groupOf(tx, spaceId, x.id);
      if (!g) throw new ApiError("invalid_state", "This break isn't matched any more. Reject the request.");
      const days = await tx.select({ d: sql<string>`${reconItems.businessDate}::text` }).from(matchMembers)
        .innerJoin(reconItems, and(eq(reconItems.spaceId, matchMembers.spaceId), eq(reconItems.id, matchMembers.itemId))).where(and(eq(matchMembers.spaceId, spaceId), eq(matchMembers.groupId, g.id)));
      await assertNotSigned(tx, spaceId, x.configId, days.map((r) => r.d));
      await tx.update(matchGroups).set({ reversedBy: ctx.user.id, reverseReason: "unmatch", reversedAt: sql`now()` }).where(and(eq(matchGroups.spaceId, spaceId), eq(matchGroups.id, g.id)));
      const ids = (await tx.select({ id: matchMembers.itemId }).from(matchMembers).where(and(eq(matchMembers.spaceId, spaceId), eq(matchMembers.groupId, g.id)))).map((m) => m.id);
      await tx.select({ id: reconItems.id }).from(reconItems).where(and(eq(reconItems.spaceId, spaceId), inArray(reconItems.id, ids))).for("update");
      await tx.update(reconItems).set({
        status: sql`case when ${reconItems.breakReason} is null then 'open' else 'break' end`,
        breakState: sql`case when ${reconItems.breakReason} is null then null when ${reconItems.assigneeId} is null then null else 'assigned' end`,
        resolution: null, version: sql`${reconItems.version} + 1`, stateAt: sql`now()`,
      }).where(and(eq(reconItems.spaceId, spaceId), inArray(reconItems.id, ids), isNull(reconItems.simRunId)));
      await recordActivity(tx, ctx, { action: "break.approve", target: { type: "break", id: x.id, label: rq.label }, before: { resolution: x.resolution }, after: { unmatched: ids.length, note: rq.note, ...extra } });
    }
    await tx.update(approvalRequests).set(decided(ctx, "approved", b.note)).where(and(eq(approvalRequests.spaceId, spaceId), eq(approvalRequests.id, rq.id)));
  });
  return breakDetail(ctx, id);
}

/** POST …/breaks/{itemId}/request/reject: with the checker's note; the break goes back to the state it had. */
export async function rejectRequest(ctx: Ctx, id: string, b: RejectRequestBody): Promise<BreakDetailDto> {
  await inSpace(ctx, async (tx, spaceId) => {
    const x = await breakOf(tx, spaceId, id);
    const rq = await pendingFor(tx, ctx, spaceId, x.id);
    if (x.breakState === "pending_approval") {
      await tx.update(reconItems).set({ breakState: rq.prevState, version: sql`${reconItems.version} + 1`, stateAt: sql`now()` })
        .where(and(eq(reconItems.spaceId, spaceId), eq(reconItems.id, x.id), eq(reconItems.businessDate, x.businessDate)));
    }
    await tx.update(approvalRequests).set(decided(ctx, "rejected", b.note)).where(and(eq(approvalRequests.spaceId, spaceId), eq(approvalRequests.id, rq.id)));
    await recordActivity(tx, ctx, { action: "break.reject", target: { type: "break", id: x.id, label: rq.label }, before: { state: x.breakState }, after: { kind: rq.kind, note: b.note, requestedBy: rq.requestedBy } });
  });
  return breakDetail(ctx, id);
}
