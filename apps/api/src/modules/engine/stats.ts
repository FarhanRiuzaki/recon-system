// The recon dashboard's rollup (docs/superpowers/plans/2026-11-24-recon-dashboard.md): one recon_day_stats row per
// live config and business date, recomputed whole from source in one upsert, so a missed, late or repeated job
// converges on the same row. Queued per (config, date) by queueStats after a run and after a change of an item
// (debounced: one job per key waits STATS_DELAY_MS, later changes merge into it), and swept nightly over the last
// SWEEP_DAYS dates (jobs.ts).
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { InTx, Tx } from "../../kernel/db";
import { enqueue, QUEUES } from "../../kernel/jobs";
import { countN } from "../../kernel/pagination";
import { approvalRequests } from "../approvals";
import { records, todayIn } from "../ingest";
import { postingGroupItems } from "../integrations";
import { reconConfigs } from "../recon";
import { spaces, withSpace } from "../spaces";
import { recordSpaces } from "./break-resolve";
import { statusTally } from "./results";
import { reconDayStats, reconItems, reconRuns } from "./schema";
import { addDays } from "./service";

/** How long a recompute waits for more changes of the same config and date. */
export const STATS_DELAY_MS = 60_000;
/** The dates the nightly sweep recomputes, ending today. */
export const SWEEP_DAYS = 7;

/** Rewrites the row of (`configId`, `date`) from the engine's tables (live items and groups only). */
export async function recomputeDayStats(tx: InTx, spaceId: string, configId: string, date: string): Promise<void> {
  const tally = await statusTally(tx, spaceId, configId, [date, date]);
  const live = and(eq(reconItems.spaceId, spaceId), eq(reconItems.configId, configId), isNull(reconItems.simRunId), eq(reconItems.businessDate, date));
  const spaces = await recordSpaces(tx, spaceId);
  const [[broke], written, resolved] = await Promise.all([
    tx.select({ n: countN }).from(reconItems).where(and(live, isNotNull(reconItems.breakReason))),
    tx.select({ ccy: records.currency, sum: sql<string>`sum(abs(${records.amountMinor}))::text`, n: countN }).from(reconItems)
      .innerJoin(records, and(inArray(records.spaceId, spaces), eq(records.id, reconItems.recordId), eq(records.businessDate, reconItems.businessDate)))
      .where(and(live, eq(reconItems.resolution, "WRITTEN_OFF"))).groupBy(records.currency),
    // from the business date's start in Asia/Jakarta, the Unmatch list's age base
    tx.select({ m: sql<number>`floor(extract(epoch from ${reconItems.stateAt} - (${date}::date::timestamp at time zone 'Asia/Jakarta')) / 60)::int` })
      .from(reconItems).where(and(live, eq(reconItems.breakState, "resolved"), isNotNull(reconItems.stateAt))),
  ]);
  const row = {
    results: Object.fromEntries(tally.map((t) => [t.status, [t.rows, t.records]])),
    broke: broke!.n,
    writtenOff: Object.fromEntries(written.flatMap((w) => (w.ccy && w.sum ? [[w.ccy, [w.sum, w.n]]] : []))),
    resolveMinutes: resolved.map((r) => r.m),
    computedAt: sql`now()`,
  };
  await tx.insert(reconDayStats).values({ spaceId, configId, businessDate: date, ...row })
    .onConflictDoUpdate({ target: [reconDayStats.spaceId, reconDayStats.configId, reconDayStats.businessDate], set: row });
}

/**
 * Queues the recompute of each (config, business date) of the live items `itemIds` of the space, in `tx` (it commits
 * with the change). A job of the same key already waiting takes this change too (stately queue: one queued per key).
 */
export async function queueStats(tx: InTx, spaceId: string, itemIds: readonly string[]): Promise<void> {
  if (!itemIds.length) return;
  const days = await tx.selectDistinct({ configId: reconItems.configId, date: sql<string>`${reconItems.businessDate}::text` }).from(reconItems)
    .where(and(eq(reconItems.spaceId, spaceId), inArray(reconItems.id, [...itemIds]), isNull(reconItems.simRunId)));
  for (const d of days) await queueDay(spaceId, d.configId, d.date, tx);
}

/** Queues the recompute of (`configId`, `date`), STATS_DELAY_MS from now. */
export function queueDay(spaceId: string, configId: string, date: string, tx?: InTx): Promise<string | null> {
  return enqueue(QUEUES.reconStats, { spaceId, configId, date }, { key: `${configId}:${date}`, startAfter: new Date(Date.now() + STATS_DELAY_MS), tx });
}

/**
 * A posting run that finished (integrations' worker): the items it posted, whose Operation result status follows it —
 * its own break, else its request's items, else its posting group's.
 */
export async function queuePostingStats(tx: InTx, r: { spaceId: string; itemId: string | null; requestId: string | null; groupId: string | null }): Promise<void> {
  if (r.itemId) return queueStats(tx, r.spaceId, [r.itemId]);
  if (r.requestId) {
    const [rq] = await tx.select({ itemId: approvalRequests.itemId, itemIds: approvalRequests.itemIds }).from(approvalRequests)
      .where(and(eq(approvalRequests.spaceId, r.spaceId), eq(approvalRequests.id, r.requestId)));
    return rq ? queueStats(tx, r.spaceId, [rq.itemId, ...rq.itemIds]) : undefined;
  }
  if (r.groupId) {
    const ms = await tx.select({ id: postingGroupItems.itemId }).from(postingGroupItems).where(and(eq(postingGroupItems.spaceId, r.spaceId), eq(postingGroupItems.groupId, r.groupId)));
    return queueStats(tx, r.spaceId, ms.map((m) => m.id));
  }
}

/** A live run's dates (each queued; a simulation changes nothing live). */
export async function queueRunStats(on: Tx, spaceId: string, runId: string): Promise<void> {
  const [r] = await withSpace({ spaceIds: [spaceId], userId: null }, (tx) => tx.select({ configId: reconRuns.configId, mode: reconRuns.mode, from: reconRuns.dateFrom, to: reconRuns.dateTo })
    .from(reconRuns).where(and(eq(reconRuns.spaceId, spaceId), eq(reconRuns.id, runId))), on);
  if (!r || r.mode === "simulation") return;
  for (let d = r.from; d <= r.to; d = addDays(d, 1)) await queueDay(spaceId, r.configId, d);
}

/** The job of (config, date): its row recomputed under the space's scope, on the worker's pool. */
export function statsJob(on: Tx, d: { spaceId: string; configId: string; date: string }): Promise<void> {
  return withSpace({ spaceIds: [d.spaceId], userId: null }, (tx) => recomputeDayStats(tx, d.spaceId, d.configId, d.date), on);
}

/**
 * The nightly sweep: every config of every space, its last SWEEP_DAYS business dates ending today (Asia/Jakarta), one
 * transaction per config and date, so a failure leaves the others written (and the next sweep tries again).
 */
export async function sweepStats(on: Tx, now = new Date()): Promise<void> {
  const today = todayIn(now);
  for (const s of await on.select({ id: spaces.id }).from(spaces)) {
    const configs = await withSpace({ spaceIds: [s.id], userId: null }, (tx) => tx.select({ id: reconConfigs.id }).from(reconConfigs).where(eq(reconConfigs.spaceId, s.id)), on);
    for (const c of configs) for (let i = SWEEP_DAYS - 1; i >= 0; i--) await statsJob(on, { spaceId: s.id, configId: c.id, date: addDays(today, -i) });
  }
}
