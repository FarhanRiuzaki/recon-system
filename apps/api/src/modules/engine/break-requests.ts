// A change of a break that needs approval (Plan 5 Task 3, now through the workflow engine, DEC-052): a force match
// (sides that total differently), unmatch (a break's match undone, its items back in the queue), write-off. Whoever may
// work the break asks, with a note; the approvals module routes the request through the space's workflow and calls
// back here: applyBreakChange when its last level passes (the change happens then, by whoever approved it last),
// revertBreakRequest when it is rejected or cancelled (the break goes back where it stood). One pending request per
// break (approval_requests_one_pending). The rule attributes: amount (the force match's gap, else the break's own
// amount, minor units), currency, recon, age in days.
import type { BreakDetailDto, RequestBreakBody } from "@starterkit/shared/contracts/breaks";
import type { Context } from "@starterkit/shared/conditions";
import type { Attributes } from "@starterkit/shared/workflows";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { InTx } from "../../kernel/db";
import { ApiError } from "../../kernel/errors";
import { openRequest } from "../approvals";
import { recordActivity } from "../audit";
import type { Ctx } from "../auth";
import { records, todayIn } from "../ingest";
import { liveSpec, postsUnmatch, breakDetail, breakOf, inSpace, itemsOf, matchIn, matchItems, mayTouch, mayWork, recordSpaces } from "./break-resolve";
import { matchGroups, matchMembers, reconItems } from "./schema";
import { assertNotSigned } from "./signoff";
import { queueStats } from "./stats";

/** The group the break is matched in now (not reversed). */
async function groupOf(tx: InTx, spaceId: string, itemId: string) {
  const [g] = await tx.select({ id: matchGroups.id }).from(matchMembers)
    .innerJoin(matchGroups, and(eq(matchGroups.spaceId, matchMembers.spaceId), eq(matchGroups.id, matchMembers.groupId)))
    .where(and(eq(matchMembers.spaceId, spaceId), eq(matchMembers.itemId, itemId), isNull(matchGroups.reversedBy), isNull(matchGroups.simRunId))).limit(1);
  return g ?? null;
}
const abs = (v: string | null) => (v === null ? undefined : (v.startsWith("-") ? v.slice(1) : v));
const ageOf = (d: string, now = new Date()) => Math.max(0, Math.round((Date.parse(`${todayIn(now)}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / 86_400_000));

/**
 * The fields an approval rule reads for a break (DEC-052 rev 2 §4.3): the break's own (amount as the rule attributes
 * have it, minor units), and the core columns and attrs of its record under its side (`side_a.attrs.channel`), then of
 * its counterparts (the force match's items, the unmatched group's other members) under theirs; the first record of a
 * side wins. A side with no record has no fields, so a clause on it fails. recon.code is added by openRequest.
 */
async function breakContext(tx: InTx, spaceId: string, x: { id: string; side: string; businessDate: string; breakReason: string | null; breakState: string | null },
  at: Attributes, counterparts: readonly string[]): Promise<Context> {
  const ids = [x.id, ...counterparts.filter((c) => c !== x.id)];
  const rows = await tx.select({ id: reconItems.id, side: reconItems.side, rec: records }).from(reconItems)
    .innerJoin(records, and(inArray(records.spaceId, await recordSpaces(tx, spaceId)), eq(records.id, reconItems.recordId), eq(records.businessDate, reconItems.businessDate)))
    .where(and(eq(reconItems.spaceId, spaceId), inArray(reconItems.id, ids)));
  const own = rows.find((r) => r.id === x.id);
  const out: Record<string, string | number | null> = {
    "break.amount": at.amount ?? null, "break.currency": at.currency ?? null, "break.business_date": x.businessDate, "break.age_days": at.ageDays ?? null,
    "break.side": x.side, "break.reason": x.breakReason, "break.state": x.breakState ?? "new", "break.reference": own?.rec.extRef ?? null,
  };
  const filled = new Set<string>();
  for (const r of ids.map((id) => rows.find((row) => row.id === id)).filter((r) => !!r)) {
    if (filled.has(r.side)) continue;
    filled.add(r.side);
    const rec = r.rec, p = `side_${r.side}.`;
    Object.assign(out, {
      [`${p}ext_ref`]: rec.extRef, [`${p}account_ref`]: rec.accountRef, [`${p}amount_minor`]: rec.amountMinor?.toString() ?? null, [`${p}currency`]: rec.currency,
      [`${p}direction`]: rec.direction, [`${p}event_time`]: rec.eventTime?.toISOString() ?? null, [`${p}business_date`]: rec.businessDate,
    });
    for (const [k, v] of Object.entries((rec.attrs ?? {}) as Record<string, unknown>)) out[`${p}attrs.${k}`] = v === null || v === undefined ? null : String(v);
  }
  return out;
}

/**
 * A break's context for an approval action (stage 4): what breakContext gives a workflow rule, read again when the
 * action fires (the amount, currency and age as they stand now), with `counterparts` under their sides.
 */
export async function breakContextOf(tx: InTx, spaceId: string, itemId: string, counterparts: readonly string[]): Promise<Context> {
  const [x] = await tx.select().from(reconItems).where(and(eq(reconItems.spaceId, spaceId), eq(reconItems.id, itemId))).limit(1);
  if (!x) return {};
  const [item] = await itemsOf(tx, spaceId, [itemId]);
  const at: Attributes = { amount: abs(item?.amountMinor ?? null), currency: item?.currency ?? null, recon: x.configId, ageDays: ageOf(x.businessDate) };
  return breakContext(tx, spaceId, x, at, counterparts);
}

/** POST …/breaks/{itemId}/request. */
export async function requestChange(ctx: Ctx, id: string, b: RequestBreakBody): Promise<BreakDetailDto> {
  await inSpace(ctx, async (tx, spaceId) => {
    const x = await breakOf(tx, spaceId, id);
    const [locked] = await tx.select({ v: reconItems.version }).from(reconItems)
      .where(and(eq(reconItems.spaceId, spaceId), eq(reconItems.id, x.id), eq(reconItems.businessDate, x.businessDate))).for("update");
    if (locked?.v !== x.version) throw new ApiError("invalid_state", "This item changed meanwhile. Reload it and try again.");
    await assertNotSigned(tx, spaceId, x.configId, [x.businessDate]);
    const [item] = await itemsOf(tx, spaceId, [x.id]);
    let itemIds: string[] = [];
    let counterparts: string[] = [];
    const attributes: Attributes = { amount: abs(item?.amountMinor ?? null), currency: item?.currency ?? null, recon: x.configId, ageDays: ageOf(x.businessDate) };
    if (b.kind === "unmatch") {
      mayTouch(ctx, x);
      const g = x.status === "matched" ? await groupOf(tx, spaceId, x.id) : null;
      if (!g) throw new ApiError("invalid_state", "This item isn't matched, so there is nothing to undo.");
      counterparts = (await tx.select({ id: matchMembers.itemId }).from(matchMembers).where(and(eq(matchMembers.spaceId, spaceId), eq(matchMembers.groupId, g.id)))).map((m) => m.id);
    } else {
      mayWork(ctx, x);
      if (b.kind === "posting" && !postsUnmatch(await liveSpec(tx, spaceId, x.configId)))
        throw new ApiError("invalid_state", "This recon doesn't post its unmatch. Set up a posting action under Posting in its Approval step.");
      if (b.kind === "force_match") {
        const m = await matchItems(tx, spaceId, x, b.itemIds);
        if (m.mixed) throw new ApiError("bad_request", m.mixed);
        if (!m.differ) throw new ApiError("invalid_state", "These totals agree: match them without approval.");
        itemIds = m.ids.slice(1);
        counterparts = itemIds;
        attributes.amount = m.gap.toString();
      }
    }
    const context = await breakContext(tx, spaceId, x, attributes, counterparts);
    await openRequest(tx, ctx, { kind: b.kind, configId: x.configId, itemId: x.id, itemIds, label: item?.ref ?? "Unmatch item", note: b.note, prevState: x.breakState, attributes, context });
    // a break waiting for a force match or write-off leaves the work states (a matched one keeps resolved meanwhile)
    if (b.kind !== "unmatch") {
      await tx.update(reconItems).set({ breakState: "pending_approval", version: sql`${reconItems.version} + 1`, stateAt: sql`now()` })
        .where(and(eq(reconItems.spaceId, spaceId), eq(reconItems.id, x.id), eq(reconItems.businessDate, x.businessDate)));
    }
    await queueStats(tx, spaceId, [x.id, ...itemIds]);
    await recordActivity(tx, ctx, {
      action: "break.request", target: { type: "break", id: x.id, label: item?.ref ?? "Unmatch item" },
      before: { state: x.breakState ?? "new" }, after: { kind: b.kind, note: b.note, ...(itemIds.length ? { items: itemIds.length } : {}) },
    });
  });
  return breakDetail(ctx, id);
}

type Rq = { spaceId: string; kind: string; itemId: string; itemIds: string[]; note: string; prevState: string | null; requestedBy: string | null };

/** The change a request asked for, done now by whoever approved it last (or overrode it); what it did, for the entry. */
export async function applyBreakChange(tx: InTx, ctx: Ctx, rq: Rq): Promise<Record<string, unknown>> {
  const spaceId = rq.spaceId;
  const x = await breakOf(tx, spaceId, rq.itemId);
  if (rq.kind === "force_match") {
    await matchIn(tx, ctx, spaceId, x, rq.itemIds, { note: rq.note, checkTotals: false, resolution: "FORCE_MATCHED", action: "break.approve", extra: { requestedBy: rq.requestedBy }, quiet: true });
    return { resolution: "FORCE_MATCHED", items: rq.itemIds.length + 1 };
  }
  // write-off and posting close the break (posting: on final approval, its posting action sends it; owner, 22 Nov)
  if (rq.kind === "write_off" || rq.kind === "posting") {
    const resolution = rq.kind === "posting" ? "POSTED" : "WRITTEN_OFF";
    await assertNotSigned(tx, spaceId, x.configId, [x.businessDate]);
    const [locked] = await tx.select({ status: reconItems.status }).from(reconItems)
      .where(and(eq(reconItems.spaceId, spaceId), eq(reconItems.id, x.id), eq(reconItems.businessDate, x.businessDate))).for("update");
    if (locked?.status !== "break") throw new ApiError("invalid_state", "This item changed meanwhile. Reject the request and ask again.");
    await tx.update(reconItems).set({ status: "closed", breakState: "resolved", resolution, version: sql`${reconItems.version} + 1`, stateAt: sql`now()` })
      .where(and(eq(reconItems.spaceId, spaceId), eq(reconItems.id, x.id), eq(reconItems.businessDate, x.businessDate)));
    await queueStats(tx, spaceId, [x.id]);
    return { resolution };
  }
  // unmatch: the group reversed by whoever approved; each member back where a run left it (a break in the queue again,
  // with whoever had it; an item that never broke open for the next run)
  const g = await groupOf(tx, spaceId, x.id);
  if (!g) throw new ApiError("invalid_state", "This item isn't matched any more. Reject the request.");
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
  await queueStats(tx, spaceId, ids);
  return { unmatched: ids.length };
}

/** A request rejected or cancelled: a break that waited for it goes back to the queue state it had. */
export async function revertBreakRequest(tx: InTx, rq: Rq): Promise<void> {
  await tx.update(reconItems).set({ breakState: rq.prevState, version: sql`${reconItems.version} + 1`, stateAt: sql`now()` })
    .where(and(eq(reconItems.spaceId, rq.spaceId), eq(reconItems.id, rq.itemId), eq(reconItems.breakState, "pending_approval"), isNull(reconItems.simRunId)));
  await queueStats(tx, rq.spaceId, [rq.itemId, ...rq.itemIds]);
}
