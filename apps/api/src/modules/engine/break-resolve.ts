// One break and its resolutions without approval (Plan 5 Task 2, spec §11, DEC-046/047): its page (the item, its
// recon, where it stands, the pair a later pass proposed), the other side's free items to match it with, a manual match
// whose sides total the same (a different total is a force match, which needs approval: Task 3), the proposed pair in
// one click, and closing it without a match (duplicate, no action) with a note. Only whoever has the break, or a space
// admin, reviewer or Superadmin. Every change locks its items, checks their status and version (A1), bumps them and
// writes one activity entry on the break.
import { ReconSpec } from "@starterkit/shared/contracts/recon";
import type { BreakCandidateQuery, BreakDetailDto, BreakItemDto, CloseBreakBody, MatchBreakBody } from "@starterkit/shared/contracts/breaks";
import type { ActivityDto, TargetActivityQuery } from "@starterkit/shared/contracts/audit";
import type { Page } from "@starterkit/shared/contracts/common";
import { isSuperadmin } from "@starterkit/shared/permissions";
import { type BreakState, type ItemStatus, type Resolution } from "@starterkit/shared/recon";
import { CURRENCY_EXPONENT, DEBIT_CODES } from "@starterkit/shared/sources";
import { formatMinor } from "@starterkit/ui/lib/format";
import { and, eq, ilike, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { InTx } from "../../kernel/db";
import { ApiError, notFound } from "../../kernel/errors";
import { likeEscape, one, pageQuery } from "../../kernel/pagination";
import { recordActivity, targetActivityPage } from "../audit";
import type { Ctx } from "../auth";
import { records, todayIn } from "../ingest";
import { reconConfigs, reconConfigVersions } from "../recon";
import { sources, sourceShares } from "../sources";
import { withSpace } from "../spaces";
import { users } from "../users";
import { matchGroups, matchMembers, reconItems } from "./schema";

const inSpace = <T>(ctx: Ctx, fn: (tx: InTx, spaceId: string) => Promise<T>) =>
  withSpace({ spaceIds: [ctx.space!.id], userId: ctx.user.id }, (tx) => fn(tx, ctx.space!.id));
const DAY_MS = 86_400_000;
/** The resolution of a person's match within the amounts (DEC-046). */
export const MATCHED_MANUAL: Resolution = "MATCHED_MANUAL";

async function recordSpaces(tx: InTx, spaceId: string): Promise<string[]> {
  const shared = await tx.selectDistinct({ id: sourceShares.spaceId }).from(sourceShares).where(eq(sourceShares.toSpaceId, spaceId));
  return [spaceId, ...shared.map((s) => s.id)];
}

/** Live items `ids` of the space with their records, as the break's page shows them; in the order of `ids`. */
async function itemsOf(tx: InTx, spaceId: string, ids: readonly string[]): Promise<(BreakItemDto & { configId: string; signed: bigint | null; v: number; state: string | null; assigneeId: string | null })[]> {
  if (!ids.length) return [];
  const spaces = await recordSpaces(tx, spaceId);
  const rows = await tx.select({
    id: reconItems.id, configId: reconItems.configId, side: reconItems.side, bd: reconItems.businessDate, status: reconItems.status, reason: reconItems.breakReason,
    v: reconItems.version, state: reconItems.breakState, assigneeId: reconItems.assigneeId,
    ref: records.extRef, amount: records.amountMinor, ccy: records.currency, dir: records.direction, at: records.eventTime, source: sources.name,
  }).from(reconItems)
    .leftJoin(records, and(inArray(records.spaceId, spaces), eq(records.id, reconItems.recordId), eq(records.businessDate, reconItems.businessDate)))
    .leftJoin(sources, and(eq(sources.spaceId, records.spaceId), eq(sources.id, records.sourceId)))
    .where(and(eq(reconItems.spaceId, spaceId), isNull(reconItems.simRunId), inArray(reconItems.id, [...ids])));
  const by = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id) => {
    const r = by.get(id);
    if (!r) return [];
    // the record's own signed amount (ingest's signedAmount): a debit code negates
    const signed = r.amount === null || r.amount === undefined ? null : DEBIT_CODES.includes((r.dir ?? "").trim().toUpperCase()) ? -r.amount : r.amount;
    return [{
      id: r.id, configId: r.configId, side: r.side as "a" | "b", businessDate: r.bd, status: r.status as ItemStatus, reason: r.reason,
      ref: r.ref ?? null, amountMinor: r.amount === null || r.amount === undefined ? null : String(r.amount), currency: r.ccy ?? null,
      eventTime: r.at ? r.at.toISOString() : null, source: r.source ?? null, signed, v: r.v, state: r.state, assigneeId: r.assigneeId,
    }];
  });
}
const plain = ({ id, side, businessDate, status, reason, ref, amountMinor, currency, eventTime, source }: BreakItemDto): BreakItemDto =>
  ({ id, side, businessDate, status, reason, ref, amountMinor, currency, eventTime, source });

/** The break `id` of the space: a live item that broke (open, resolved or matched since); else 404. */
async function breakOf(tx: InTx, spaceId: string, id: string) {
  const [x] = await tx.select().from(reconItems)
    .where(and(eq(reconItems.spaceId, spaceId), eq(reconItems.id, id), isNull(reconItems.simRunId), or(eq(reconItems.status, "break"), sql`${reconItems.breakReason} is not null`)));
  if (!x) throw notFound("break");
  return x;
}
/** The config's published spec (its side labels, signs) and version id. */
async function published(tx: InTx, spaceId: string, configId: string) {
  const [v] = await tx.select({ id: reconConfigVersions.id, spec: reconConfigVersions.spec }).from(reconConfigVersions)
    .where(and(eq(reconConfigVersions.spaceId, spaceId), eq(reconConfigVersions.configId, configId), eq(reconConfigVersions.status, "published")));
  if (!v) throw new ApiError("invalid_state", "This recon has no approved version running, so its breaks can't change.");
  return { id: v.id, spec: ReconSpec.parse(v.spec) };
}
/** An item free to match: live, open or a break nobody resolved. */
const free = (i: { status: string; state: string | null }) => i.status === "open" || (i.status === "break" && i.state !== "resolved");

/** GET …/breaks/{itemId}. */
export function breakDetail(ctx: Ctx, id: string, now = new Date()): Promise<BreakDetailDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const x = await breakOf(tx, spaceId, id);
    const [item] = await itemsOf(tx, spaceId, [x.id]);
    const [c] = await tx.select({ name: reconConfigs.name }).from(reconConfigs).where(and(eq(reconConfigs.spaceId, spaceId), eq(reconConfigs.id, x.configId)));
    const [v] = await tx.select({ spec: reconConfigVersions.spec }).from(reconConfigVersions)
      .where(and(eq(reconConfigVersions.spaceId, spaceId), eq(reconConfigVersions.configId, x.configId), eq(reconConfigVersions.status, "published")));
    const sides = v ? ReconSpec.parse(v.spec).sides.map((s) => s.label) as [string, string] : ["Side A", "Side B"] as [string, string];
    // the group it is matched in now (not reversed): its other members
    const g = x.status === "matched"
      ? (await tx.select({ id: matchMembers.groupId }).from(matchMembers).innerJoin(matchGroups, and(eq(matchGroups.spaceId, matchMembers.spaceId), eq(matchGroups.id, matchMembers.groupId)))
        .where(and(eq(matchMembers.spaceId, spaceId), eq(matchMembers.itemId, x.id), isNull(matchGroups.reversedBy))).limit(1))[0]
      : undefined;
    const others = g ? (await tx.select({ id: matchMembers.itemId }).from(matchMembers).where(and(eq(matchMembers.spaceId, spaceId), eq(matchMembers.groupId, g.id), ne(matchMembers.itemId, x.id)))).map((m) => m.id) : [];
    const matchedWith = await itemsOf(tx, spaceId, others);
    const [p] = x.proposedItemId ? await itemsOf(tx, spaceId, [x.proposedItemId]) : [];
    const name = x.assigneeId ? (await tx.select({ name: users.name }).from(users).where(eq(users.id, x.assigneeId)))[0]?.name ?? null : null;
    const today = todayIn(now);
    return {
      item: plain(item!), recon: { id: x.configId, name: c?.name ?? "Recon", sides }, state: (x.breakState ?? "new") as BreakState,
      assignee: x.assigneeId ? { id: x.assigneeId, name } : null,
      ageDays: Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${x.businessDate}T00:00:00Z`)) / DAY_MS)),
      resolution: (x.resolution as Resolution | null) ?? null, matchedWith: matchedWith.map(plain),
      proposed: p ? { item: plain(p), pass: x.proposedPass, available: free(p) } : null,
    };
  });
}

/** GET …/breaks/{itemId}/candidates: the other side's free items of the same recon, nearest amount first, then nearest date. */
export function candidatePage(ctx: Ctx, id: string, q: BreakCandidateQuery): Promise<Page<BreakItemDto>> {
  return inSpace(ctx, async (tx, spaceId) => {
    const x = await breakOf(tx, spaceId, id);
    const spaces = await recordSpaces(tx, spaceId);
    const [mine] = await itemsOf(tx, spaceId, [x.id]);
    const like = q.q?.trim() ? `%${likeEscape(q.q.trim())}%` : null;
    const record = and(inArray(records.spaceId, spaces), eq(records.id, reconItems.recordId), eq(records.businessDate, reconItems.businessDate));
    const where = and(eq(reconItems.spaceId, spaceId), eq(reconItems.configId, x.configId), isNull(reconItems.simRunId), ne(reconItems.side, x.side),
      or(eq(reconItems.status, "open"), and(eq(reconItems.status, "break"), or(isNull(reconItems.breakState), ne(reconItems.breakState, "resolved")))),
      like ? ilike(records.extRef, like) : undefined);
    const amount = mine?.amountMinor ?? null;
    const page = await pageQuery({
      rows: tx.select({ id: reconItems.id }).from(reconItems).leftJoin(records, record).where(where).$dynamic(),
      count: tx.select(one).from(reconItems).leftJoin(records, record).where(where).$dynamic(),
      orderBy: [
        amount === null ? sql`0` : sql`abs(coalesce(${records.amountMinor}, 0) - ${amount}::bigint)`,
        sql`abs(${reconItems.businessDate} - ${x.businessDate}::date)`, sql`${reconItems.id}`,
      ],
      query: { ...q, page: q.page, pageSize: q.pageSize },
      map: (r) => r.id as string,
      on: tx,
    });
    return { ...page, items: (await itemsOf(tx, spaceId, page.items)).map(plain) };
  });
}

/** Whoever has the break, or a space admin, reviewer or Superadmin; else 403. A resolved break is 409. */
function mayWork(ctx: Ctx, x: { assigneeId: string | null; breakState: string | null; status: string }) {
  if (x.status !== "break" || x.breakState === "resolved") throw new ApiError("invalid_state", "This break is resolved already.");
  const lead = isSuperadmin(ctx.user.roles) || ctx.space!.roles.some((r) => r === "space_admin" || r === "reviewer");
  if (!lead && x.assigneeId !== ctx.user.id) throw new ApiError("forbidden", "Take this break first: only whoever has it resolves it.");
}

const amountText = (minor: bigint, ccy: string | null) => { const e = ccy ? CURRENCY_EXPONENT[ccy] : undefined; return e === undefined ? String(minor) : formatMinor(minor, e); };

/**
 * One manual match of the break with `otherIds` (DEC-046): items of the recon free to match, both sides present, one
 * currency, side A's total equal to side B's (on the recon's sign convention). `checkTotals` false = a proposed pair a
 * suggesting pass already found within its tolerance (DEC-047). A group of kind manual (no run), every item matched,
 * the breaks among them resolved MATCHED_MANUAL; one break.match entry on the break.
 */
async function match(ctx: Ctx, id: string, otherIds: readonly string[], o: { note?: string; checkTotals: boolean; pass?: number | null }): Promise<void> {
  return inSpace(ctx, async (tx, spaceId) => {
    const x = await breakOf(tx, spaceId, id);
    mayWork(ctx, x);
    const ids = [x.id, ...otherIds.filter((i) => i !== x.id)];
    // lock them all at the status read (A1): an item an operator or a run holds waits; a moved one refuses below
    await tx.select({ id: reconItems.id }).from(reconItems).where(and(eq(reconItems.spaceId, spaceId), inArray(reconItems.id, ids))).for("update");
    const items = await itemsOf(tx, spaceId, ids);
    if (items.length !== ids.length || items.some((i) => i.configId !== x.configId)) throw new ApiError("bad_request", "Match items of this recon only.");
    const gone = items.find((i) => !free(i));
    if (gone) throw new ApiError("invalid_state", `${gone.ref ?? "An item"} is no longer free to match (${gone.status}). Reload and pick again.`);
    if (!items.some((i) => i.side === "a") || !items.some((i) => i.side === "b")) throw new ApiError("bad_request", "A match needs items of both sides.");
    const v = await published(tx, spaceId, x.configId);
    const ccys = new Set(items.map((i) => i.currency));
    if (o.checkTotals) {
      if (ccys.size > 1) throw new ApiError("bad_request", "These items are in different currencies. Match items of one currency.");
      const ccy = [...ccys][0] ?? null;
      // the recon's convention (pass.ts comparedAmount): a side with amount_sign negate is negated
      const total = (side: "a" | "b") => items.filter((i) => i.side === side).reduce((t, i) => t + (i.signed ?? 0n) * (v.spec.sides[side === "a" ? 0 : 1].amount_sign === "negate" ? -1n : 1n), 0n);
      const a = total("a"), b = total("b");
      if (a !== b) {
        throw new ApiError("invalid_state", `${v.spec.sides[0].label} totals ${amountText(a, ccy)} and ${v.spec.sides[1].label} ${amountText(b, ccy)}: they differ by ${amountText(a > b ? a - b : b - a, ccy)}. A match across a difference needs approval (force match).`);
      }
    }
    const gid = Bun.randomUUIDv7();
    const latest = items.reduce((d, i) => (i.businessDate > d ? i.businessDate : d), items[0]!.businessDate);
    await tx.insert(matchGroups).values({
      id: gid, spaceId, configId: x.configId, configVersionId: v.id, runId: null, simRunId: null, passNo: o.pass ?? 0, kind: "manual", businessDate: latest,
      evidence: { manual: true, by: ctx.user.id, ...(o.note ? { note: o.note } : {}), ...(o.pass ? { proposedBy: o.pass } : {}), items: ids.length },
    });
    await tx.insert(matchMembers).values(items.map((i) => ({ groupId: gid, spaceId, itemId: i.id, side: i.side, signedAmount: i.signed })));
    for (const i of items) {
      await tx.update(reconItems).set({
        status: "matched", version: sql`${reconItems.version} + 1`, stateAt: sql`now()`,
        ...(i.status === "break" ? { breakState: "resolved", resolution: MATCHED_MANUAL } : {}),
      }).where(and(eq(reconItems.spaceId, spaceId), eq(reconItems.id, i.id), eq(reconItems.businessDate, i.businessDate), eq(reconItems.version, i.v)));
    }
    await recordActivity(tx, ctx, {
      action: "break.match", target: { type: "break", id: x.id, label: items[0]!.ref ?? "Break" },
      before: { state: x.breakState ?? "new" },
      after: { resolution: MATCHED_MANUAL, items: items.map((i) => ({ side: i.side, ref: i.ref })), ...(o.pass ? { proposedBy: o.pass } : {}), ...(o.note ? { note: o.note } : {}) },
    });
  });
}

/** POST …/breaks/{itemId}/match. */
export async function matchBreak(ctx: Ctx, id: string, b: MatchBreakBody): Promise<BreakDetailDto> {
  await match(ctx, id, b.itemIds, { note: b.note, checkTotals: true });
  return breakDetail(ctx, id);
}

/** POST …/breaks/{itemId}/match-pair: the pair a later suggesting pass proposed (DEC-047), if that item is still free. */
export async function matchPair(ctx: Ctx, id: string): Promise<BreakDetailDto> {
  const x = await inSpace(ctx, (tx, spaceId) => breakOf(tx, spaceId, id));
  if (!x.proposedItemId) throw new ApiError("invalid_state", "No pair is proposed for this break.");
  await match(ctx, id, [x.proposedItemId], { checkTotals: false, pass: x.proposedPass });
  return breakDetail(ctx, id);
}

/** POST …/breaks/{itemId}/close: resolved without a match (duplicate, no action), with the note; it no longer counts as open. */
export async function closeBreak(ctx: Ctx, id: string, b: CloseBreakBody): Promise<BreakDetailDto> {
  await inSpace(ctx, async (tx, spaceId) => {
    const x = await breakOf(tx, spaceId, id);
    mayWork(ctx, x);
    const [locked] = await tx.select({ v: reconItems.version, status: reconItems.status }).from(reconItems)
      .where(and(eq(reconItems.spaceId, spaceId), eq(reconItems.id, x.id), eq(reconItems.businessDate, x.businessDate))).for("update");
    if (locked?.status !== "break" || locked.v !== x.version) throw new ApiError("invalid_state", "This break changed meanwhile. Reload it and try again.");
    await tx.update(reconItems).set({ status: "closed", breakState: "resolved", resolution: b.resolution, version: sql`${reconItems.version} + 1`, stateAt: sql`now()` })
      .where(and(eq(reconItems.spaceId, spaceId), eq(reconItems.id, x.id), eq(reconItems.businessDate, x.businessDate), eq(reconItems.version, x.version)));
    const [i] = await itemsOf(tx, spaceId, [x.id]);
    await recordActivity(tx, ctx, { action: "break.close", target: { type: "break", id: x.id, label: i?.ref ?? "Break" }, before: { state: x.breakState ?? "new" }, after: { resolution: b.resolution, note: b.note } });
  });
  return breakDetail(ctx, id);
}

/** GET …/breaks/{itemId}/activity: the break's own trail, newest first (read through the audit module). */
export async function breakActivity(ctx: Ctx, id: string, q: TargetActivityQuery): Promise<Page<ActivityDto>> {
  await inSpace(ctx, (tx, spaceId) => breakOf(tx, spaceId, id));
  return targetActivityPage({ type: "break", id }, q);
}
