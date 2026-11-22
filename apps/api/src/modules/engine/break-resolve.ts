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
import { DEFAULT_CHAIN, TRIGGERS } from "@starterkit/shared/workflows";
import { CURRENCY_EXPONENT, DEBIT_CODES } from "@starterkit/shared/sources";
import { formatMinor } from "@starterkit/ui/lib/format";
import { and, desc, eq, ilike, inArray, isNotNull, isNull, ne, notInArray, or, sql } from "drizzle-orm";
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
import { approvalRequests, pinnedVersion, requestView } from "../approvals";
import { connectors, runsOf } from "../integrations";
import { matchGroups, matchMembers, reconDays, reconItems } from "./schema";
import { addDays } from "./service";
import { NEAR_MISS } from "./sql/breaks";
import { assertNotSigned } from "./signoff";

export const inSpace = <T>(ctx: Ctx, fn: (tx: InTx, spaceId: string) => Promise<T>) =>
  withSpace({ spaceIds: [ctx.space!.id], userId: ctx.user.id }, (tx) => fn(tx, ctx.space!.id));
const DAY_MS = 86_400_000;
/** The resolution of a person's match within the amounts (DEC-046). */
export const MATCHED_MANUAL: Resolution = "MATCHED_MANUAL";

export async function recordSpaces(tx: InTx, spaceId: string): Promise<string[]> {
  const shared = await tx.selectDistinct({ id: sourceShares.spaceId }).from(sourceShares).where(eq(sourceShares.toSpaceId, spaceId));
  return [spaceId, ...shared.map((s) => s.id)];
}

/** Live items `ids` of the space with their records, as the break's page shows them; in the order of `ids`. */
export async function itemsOf(tx: InTx, spaceId: string, ids: readonly string[]): Promise<(BreakItemDto & { configId: string; signed: bigint | null; v: number; state: string | null; assigneeId: string | null })[]> {
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
export const plain = ({ id, side, businessDate, status, reason, ref, amountMinor, currency, eventTime, source }: BreakItemDto): BreakItemDto =>
  ({ id, side, businessDate, status, reason, ref, amountMinor, currency, eventTime, source });

/** The break `id` of the space: a live item that broke (open, resolved or matched since); else 404. */
export async function breakOf(tx: InTx, spaceId: string, id: string) {
  const [x] = await tx.select().from(reconItems)
    .where(and(eq(reconItems.spaceId, spaceId), eq(reconItems.id, id), isNull(reconItems.simRunId), or(eq(reconItems.status, "break"), sql`${reconItems.breakReason} is not null`)));
  if (!x) throw notFound("break");
  return x;
}
/** The config's published spec (its side labels, signs) and version id. */
async function published(tx: InTx, spaceId: string, configId: string) {
  const [v] = await tx.select({ id: reconConfigVersions.id, spec: reconConfigVersions.spec }).from(reconConfigVersions)
    .where(and(eq(reconConfigVersions.spaceId, spaceId), eq(reconConfigVersions.configId, configId), eq(reconConfigVersions.status, "published")));
  if (!v) throw new ApiError("invalid_state", "This recon has no approved version running, so its items can't change.");
  return { id: v.id, spec: ReconSpec.parse(v.spec) };
}
/** An item free to match: live, open or a break nobody resolved and no request holds. */
export const free = (i: { status: string; state: string | null }) => i.status === "open" || (i.status === "break" && i.state !== "resolved" && i.state !== "pending_approval");

/** GET …/breaks/{itemId}. */
/** Whether a recon spec posts its unmatch: a posting action under its Posting change (owner, 22 Nov: by configuration). */
export const postsUnmatch = (spec: ReconSpec | null) => !!spec?.approvals?.changes.posting?.actions.some((a) => a.kind === "posting");
/** The live version's spec of recon `configId`, or null before its first approval. */
export async function liveSpec(tx: InTx, spaceId: string, configId: string): Promise<ReconSpec | null> {
  const [v] = await tx.select({ spec: reconConfigVersions.spec }).from(reconConfigVersions)
    .where(and(eq(reconConfigVersions.spaceId, spaceId), eq(reconConfigVersions.configId, configId), eq(reconConfigVersions.status, "published")));
  return v ? ReconSpec.parse(v.spec) : null;
}

/**
 * Where each change kind's request goes by default on the live spec: its default workflow (name, levels) or the
 * default chain, and the connector its first posting action calls. A pinned version that is gone leaves the kind out
 * (asking for it is refused with the reason).
 */
async function routesOf(tx: InTx, spaceId: string, spec: ReconSpec | null): Promise<BreakDetailDto["recon"]["routes"]> {
  const changes = spec?.approvals?.changes ?? {};
  const ops = TRIGGERS.map((k) => changes[k]?.actions.find((a) => a.kind === "posting")?.variants[0]?.operation.connectorId ?? null);
  const ids = [...new Set(ops.filter((x): x is string => !!x))];
  const names = new Map(ids.length ? (await tx.select({ id: connectors.id, name: connectors.name }).from(connectors).where(inArray(connectors.id, ids))).map((c) => [c.id, c.name]) : []);
  const out: BreakDetailDto["recon"]["routes"] = [];
  for (const [i, kind] of TRIGGERS.entries()) {
    const ref = changes[kind]?.workflow.default ?? null;
    const v = ref ? await pinnedVersion(tx, spaceId, ref) : null;
    if (ref && !v) continue;
    out.push({ kind, workflowName: v?.name ?? null, levels: (v?.spec ?? DEFAULT_CHAIN).levels.length, connector: ops[i] ? names.get(ops[i]!) ?? null : null });
  }
  return out;
}

/**
 * Whether runs look for the item's counterpart again: the engine's pool (sql/pass.ts poolStatus) holds an open item,
 * and with carry over above 0 (or always) a "No counterpart" break with late_match that waits for no decision on a
 * day not signed off. Carry over is calendar days from the business date (engine addDays).
 */
async function recheckOf(tx: InTx, spaceId: string, x: typeof reconItems.$inferSelect, live: ReconSpec | null): Promise<BreakDetailDto["recon"]["recheck"]> {
  const carry = live ? live.carry_over_days : 0;
  const pooled = x.status === "open" || (x.status === "break" && x.lateMatch && x.breakReason === NEAR_MISS.none && x.breakState !== "pending_approval"
    && carry !== 0 && !(await signed(tx, spaceId, x.configId, x.businessDate)));
  if (!live || !pooled) return { kind: "no" };
  return carry === null ? { kind: "always" } : { kind: "until", date: addDays(x.businessDate, carry) };
}
const signed = async (tx: InTx, spaceId: string, configId: string, d: string) => (await tx.select({ d: reconDays.businessDate }).from(reconDays)
  .where(and(eq(reconDays.spaceId, spaceId), eq(reconDays.configId, configId), eq(reconDays.businessDate, d), isNotNull(reconDays.signedAt))).limit(1)).length > 0;

export function breakDetail(ctx: Ctx, id: string, now = new Date()): Promise<BreakDetailDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const x = await breakOf(tx, spaceId, id);
    const [item] = await itemsOf(tx, spaceId, [x.id]);
    const [c] = await tx.select({ name: reconConfigs.name }).from(reconConfigs).where(and(eq(reconConfigs.spaceId, spaceId), eq(reconConfigs.id, x.configId)));
    const live = await liveSpec(tx, spaceId, x.configId);
    const sides = live ? live.sides.map((s) => s.label) as [string, string] : ["Side A", "Side B"] as [string, string];
    // the group it is matched in now (not reversed): its other members
    const g = x.status === "matched"
      ? (await tx.select({ id: matchMembers.groupId }).from(matchMembers).innerJoin(matchGroups, and(eq(matchGroups.spaceId, matchMembers.spaceId), eq(matchGroups.id, matchMembers.groupId)))
        .where(and(eq(matchMembers.spaceId, spaceId), eq(matchMembers.itemId, x.id), isNull(matchGroups.reversedBy))).limit(1))[0]
      : undefined;
    const others = g ? (await tx.select({ id: matchMembers.itemId }).from(matchMembers).where(and(eq(matchMembers.spaceId, spaceId), eq(matchMembers.groupId, g.id), ne(matchMembers.itemId, x.id)))).map((m) => m.id) : [];
    const matchedWith = await itemsOf(tx, spaceId, others);
    const [p] = x.proposedItemId ? await itemsOf(tx, spaceId, [x.proposedItemId]) : [];
    // its latest request (waiting, or how the last one ended), as its timeline
    const [rq] = await tx.select().from(approvalRequests).where(and(eq(approvalRequests.spaceId, spaceId), eq(approvalRequests.itemId, x.id))).orderBy(desc(approvalRequests.requestedAt)).limit(1);
    const people = [...new Set([x.assigneeId].filter((u): u is string => !!u))];
    const names = new Map(people.length ? (await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, people))).map((u) => [u.id, u.name]) : []);
    const name = x.assigneeId ? names.get(x.assigneeId) ?? null : null;
    const today = todayIn(now);
    return {
      item: plain(item!), recon: {
        id: x.configId, name: c?.name ?? "Recon", sides, posts: postsUnmatch(live),
        // carry over is calendar days from the business date (engine addDays); before a first approval it reads as always
        carryOverDays: live?.carry_over_days ?? null, recheck: await recheckOf(tx, spaceId, x, live),
        routes: await routesOf(tx, spaceId, live),
      }, state: (x.breakState ?? "new") as BreakState,
      assignee: x.assigneeId ? { id: x.assigneeId, name } : null,
      ageDays: Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${x.businessDate}T00:00:00Z`)) / DAY_MS)),
      resolution: (x.resolution as Resolution | null) ?? null, matchedWith: matchedWith.map(plain),
      proposed: p ? { item: plain(p), pass: x.proposedPass, available: free(p) } : null,
      request: rq ? { ...(await requestView(tx, ctx, rq)), items: (await itemsOf(tx, spaceId, rq.itemIds)).map(plain) } : null,
      // its actions and posting result (stage 4); the masked payload and answer for an Open API reader or the space admin
      ...(rq ? await runsOf(tx, spaceId, rq.id, x.id, ctx.perms.has("integration.view") || !!ctx.space?.roles.includes("space_admin")) : { actions: [], posting: null }),
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
      or(eq(reconItems.status, "open"), and(eq(reconItems.status, "break"), or(isNull(reconItems.breakState), notInArray(reconItems.breakState, ["resolved", "pending_approval"])))),
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

/** A space admin, reviewer or Superadmin: works anyone's break, decides break requests. */
export const isLead = (ctx: Ctx) => isSuperadmin(ctx.user.roles) || ctx.space!.roles.some((r) => r === "space_admin" || r === "reviewer");
/** Whoever has the break, or a lead; else 403. */
export function mayTouch(ctx: Ctx, x: { assigneeId: string | null }) {
  if (!isLead(ctx) && x.assigneeId !== ctx.user.id) throw new ApiError("forbidden", "Take this item first: only whoever has it resolves it.");
}
/** An open break whoever has it (or a lead) may resolve; a resolved one or one waiting for a checker is 409. */
export function mayWork(ctx: Ctx, x: { assigneeId: string | null; breakState: string | null; status: string }) {
  if (x.status !== "break" || x.breakState === "resolved") throw new ApiError("invalid_state", "This item is resolved already.");
  if (x.breakState === "pending_approval") throw new ApiError("invalid_state", "A change of this item waits for a checker's decision.");
  mayTouch(ctx, x);
}

export const amountText = (minor: bigint, ccy: string | null) => { const e = ccy ? CURRENCY_EXPONENT[ccy] : undefined; return e === undefined ? String(minor) : formatMinor(minor, e); };

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
    await matchIn(tx, ctx, spaceId, x, otherIds, { ...o, resolution: MATCHED_MANUAL, action: "break.match" });
  });
}

/** `quiet`: the caller records the activity entry (an approval's, which carries the chain). */
type MatchOptions = { note?: string; checkTotals: boolean; pass?: number | null; resolution: Resolution; action: "break.match" | "break.approve"; extra?: Record<string, unknown>; quiet?: boolean };
/** A break's items, locked and checked: free, of its recon, both sides present; with the recon's published version. */
export async function matchItems(tx: InTx, spaceId: string, x: { id: string; configId: string }, otherIds: readonly string[]) {
    const ids = [x.id, ...otherIds.filter((i) => i !== x.id)];
    // lock them all at the status read (A1): an item an operator or a run holds waits; a moved one refuses below
    await tx.select({ id: reconItems.id }).from(reconItems).where(and(eq(reconItems.spaceId, spaceId), inArray(reconItems.id, ids))).for("update");
    const items = await itemsOf(tx, spaceId, ids);
    if (items.length !== ids.length || items.some((i) => i.configId !== x.configId)) throw new ApiError("bad_request", "Match items of this recon only.");
    // the break itself may wait for its own request (an approved force match); every other item must be free
    const gone = items.find((i) => (i.id === x.id ? i.status !== "break" || i.state === "resolved" : !free(i)));
    if (gone) throw new ApiError("invalid_state", `${gone.ref ?? "An item"} is no longer free to match (${gone.status}). Reload and pick again.`);
    if (!items.some((i) => i.side === "a") || !items.some((i) => i.side === "b")) throw new ApiError("bad_request", "A match needs items of both sides.");
    const v = await published(tx, spaceId, x.configId);
    const ccys = new Set(items.map((i) => i.currency));
    const mixed = ccys.size > 1 ? "These items are in different currencies. Match items of one currency." : null;
    const ccy = [...ccys][0] ?? null;
    // the recon's convention (pass.ts comparedAmount): a side with amount_sign negate is negated
    const total = (side: "a" | "b") => items.filter((i) => i.side === side).reduce((t, i) => t + (i.signed ?? 0n) * (v.spec.sides[side === "a" ? 0 : 1].amount_sign === "negate" ? -1n : 1n), 0n);
    const a = total("a"), b = total("b");
    const differ = a === b ? null : `${v.spec.sides[0].label} totals ${amountText(a, ccy)} and ${v.spec.sides[1].label} ${amountText(b, ccy)}: they differ by ${amountText(a > b ? a - b : b - a, ccy)}.`;
    return { ids, items, v, differ, mixed, gap: a > b ? a - b : b - a, ccy };
}

/** The match itself, in the caller's transaction, after its rules (match, or an approved force match). */
export async function matchIn(tx: InTx, ctx: Ctx, spaceId: string, x: { id: string; configId: string; breakState: string | null }, otherIds: readonly string[], o: MatchOptions): Promise<void> {
    const { ids, items, v, differ, mixed } = await matchItems(tx, spaceId, x, otherIds);
    await assertNotSigned(tx, spaceId, x.configId, items.map((i) => i.businessDate));
    if (o.checkTotals && mixed) throw new ApiError("bad_request", mixed);
    if (o.checkTotals && differ) throw new ApiError("invalid_state", `${differ} A match across a difference needs approval (force match).`);
    const gid = Bun.randomUUIDv7();
    const latest = items.reduce((d, i) => (i.businessDate > d ? i.businessDate : d), items[0]!.businessDate);
    await tx.insert(matchGroups).values({
      id: gid, spaceId, configId: x.configId, configVersionId: v.id, runId: null, simRunId: null, passNo: o.pass ?? 0, kind: "manual", businessDate: latest,
      evidence: { manual: true, by: ctx.user.id, resolution: o.resolution, ...(o.note ? { note: o.note } : {}), ...(o.pass ? { proposedBy: o.pass } : {}), ...o.extra, items: ids.length },
    });
    await tx.insert(matchMembers).values(items.map((i) => ({ groupId: gid, spaceId, itemId: i.id, side: i.side, signedAmount: i.signed })));
    for (const i of items) {
      await tx.update(reconItems).set({
        status: "matched", version: sql`${reconItems.version} + 1`, stateAt: sql`now()`,
        ...(i.status === "break" ? { breakState: "resolved", resolution: o.resolution } : {}),
      }).where(and(eq(reconItems.spaceId, spaceId), eq(reconItems.id, i.id), eq(reconItems.businessDate, i.businessDate), eq(reconItems.version, i.v)));
    }
    if (o.quiet) return;
    await recordActivity(tx, ctx, {
      action: o.action, target: { type: "break", id: x.id, label: items[0]!.ref ?? "Unmatch item" },
      before: { state: x.breakState ?? "new" },
      after: { resolution: o.resolution, items: items.map((i) => ({ side: i.side, ref: i.ref })), ...(o.pass ? { proposedBy: o.pass } : {}), ...(o.note ? { note: o.note } : {}), ...o.extra },
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
  if (!x.proposedItemId) throw new ApiError("invalid_state", "No pair is proposed for this item.");
  await match(ctx, id, [x.proposedItemId], { checkTotals: false, pass: x.proposedPass });
  return breakDetail(ctx, id);
}

/** POST …/breaks/{itemId}/close: resolved without a match (duplicate, no action), with the note; it no longer counts as open. */
export async function closeBreak(ctx: Ctx, id: string, b: CloseBreakBody): Promise<BreakDetailDto> {
  await inSpace(ctx, async (tx, spaceId) => {
    const x = await breakOf(tx, spaceId, id);
    mayWork(ctx, x);
    await assertNotSigned(tx, spaceId, x.configId, [x.businessDate]);
    const [locked] = await tx.select({ v: reconItems.version, status: reconItems.status }).from(reconItems)
      .where(and(eq(reconItems.spaceId, spaceId), eq(reconItems.id, x.id), eq(reconItems.businessDate, x.businessDate))).for("update");
    if (locked?.status !== "break" || locked.v !== x.version) throw new ApiError("invalid_state", "This item changed meanwhile. Reload it and try again.");
    await tx.update(reconItems).set({ status: "closed", breakState: "resolved", resolution: b.resolution, version: sql`${reconItems.version} + 1`, stateAt: sql`now()` })
      .where(and(eq(reconItems.spaceId, spaceId), eq(reconItems.id, x.id), eq(reconItems.businessDate, x.businessDate), eq(reconItems.version, x.version)));
    const [i] = await itemsOf(tx, spaceId, [x.id]);
    await recordActivity(tx, ctx, { action: "break.close", target: { type: "break", id: x.id, label: i?.ref ?? "Unmatch item" }, before: { state: x.breakState ?? "new" }, after: { resolution: b.resolution, note: b.note } });
  });
  return breakDetail(ctx, id);
}

/** GET …/breaks/{itemId}/activity: the break's own trail, newest first (read through the audit module). */
export async function breakActivity(ctx: Ctx, id: string, q: TargetActivityQuery): Promise<Page<ActivityDto>> {
  await inSpace(ctx, (tx, spaceId) => breakOf(tx, spaceId, id));
  return targetActivityPage({ type: "break", id }, q);
}
