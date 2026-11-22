// The schedule (spec §9, Task 6). One cron job, every minute on its own queue recon.schedule (worker.ts), looks at
// every active recon with a published version and, from state alone (its closed and closing days, its first publish,
// its last scheduled run, what that run saw of its sources: rules.ts planRun), starts the run that is due: `tick` for
// an interval recon (recon.tick), `daily` for a daily one (recon.daily). A run starts only through claimConfig, as a
// manual one does: one run of a config at a time, and a run whose worker died is failed there (reaper) before the next
// starts. A worker that was down catches up by itself: the next run covers every date since the last closed one. The
// run's job then sweeps the closed dates before it (breaks.ts sweepClosed) and closes each of its dates whose close
// moment has passed (closeDay), in order, stopping at a date that still waits for data. While a date waits for data,
// a new run starts only when a side's source moved past what the last run saw, or close + grace has passed; a config
// whose last scheduled run failed waits (rules.ts backoffMs).
//
// Chosen over a pg-boss schedule per config (scheduleEvery): a cron can't say "every 90 minutes", and a schedule per
// config would have to follow every publish, pause and retire; this job reads them as they are. ponytail: one job
// reads every config each minute; shard by space if that read grows past a few hundred milliseconds.
import { ReconSpec } from "@starterkit/shared/contracts/recon";
import { and, desc, eq, inArray, isNotNull, isNull, max, min, ne, sql } from "drizzle-orm";
import type { InTx, Tx } from "../../kernel/db";
import { ApiError, errorDetail } from "../../kernel/errors";
import { log } from "../../kernel/log";
import { endOfDay, sourceCursors, todayIn } from "../ingest";
import { reconConfigs, reconConfigVersions } from "../recon";
import { spaces, withSpace } from "../spaces";
import { closeDay, seenOn, sweepClosed } from "./breaks";
import { claimConfig, runJob, send } from "./jobs";
import { ALERT_REPEAT_MS, closeMoment, planRun, type ScheduleState, staleNow } from "./rules";
import { reconAlerts, reconDays, reconRuns } from "./schema";
import { addDays, createRun, effectiveCarry, refreshRunDays } from "./service";

const SCHEDULED = ["tick", "daily"] as const;

/** A recon the schedule looks at: its published version and what rules.ts planRun needs. */
type Due = ScheduleState & { spaceId: string; configId: string; versionId: string; spec: ReconSpec; lastSuccess: Date | null };

/**
 * Every active recon of an active space with a published version, with its schedule state: a few queries for them all,
 * plus two for each recon with a date closing (what its last run saw, its sources' cursors now).
 */
async function scheduled(on: Tx, now: Date): Promise<Due[]> {
  const ids = (await on.select({ id: spaces.id }).from(spaces).where(ne(spaces.status, "archived"))).map((s) => s.id);
  if (!ids.length) return [];
  return withSpace({ spaceIds: ids, userId: null }, async (tx) => {
    const pub = await tx.select({ spaceId: reconConfigVersions.spaceId, configId: reconConfigVersions.configId, versionId: reconConfigVersions.id, spec: reconConfigVersions.spec })
      .from(reconConfigVersions).innerJoin(reconConfigs, and(eq(reconConfigs.spaceId, reconConfigVersions.spaceId), eq(reconConfigs.id, reconConfigVersions.configId)))
      .where(and(inArray(reconConfigVersions.spaceId, ids), eq(reconConfigVersions.status, "published"), eq(reconConfigs.status, "active")));
    if (!pub.length) return [];
    const cfgs = pub.map((p) => p.configId);
    const first = new Map((await tx.select({ id: reconConfigVersions.configId, at: min(reconConfigVersions.publishedAt) }).from(reconConfigVersions)
      .where(and(inArray(reconConfigVersions.spaceId, ids), inArray(reconConfigVersions.configId, cfgs))).groupBy(reconConfigVersions.configId)).map((r) => [r.id, r.at]));
    const days = await tx.select({ id: reconDays.configId, status: reconDays.status, d: sql<string>`(case when ${reconDays.status} = 'closed' then max(${reconDays.businessDate}) else min(${reconDays.businessDate}) end)::text` })
      .from(reconDays).where(and(inArray(reconDays.spaceId, ids), inArray(reconDays.configId, cfgs))).groupBy(reconDays.configId, reconDays.status);
    const scope = and(inArray(reconRuns.spaceId, ids), inArray(reconRuns.configId, cfgs), inArray(reconRuns.mode, [...SCHEDULED]));
    const success = new Map((await tx.select({ id: reconRuns.configId, at: max(reconRuns.finishedAt) }).from(reconRuns)
      .where(and(scope, eq(reconRuns.status, "succeeded"))).groupBy(reconRuns.configId)).map((r) => [r.id, r.at]));
    // the latest scheduled run of each config: when it started, and whether it failed (backoff)
    const latest = tx.select({ id: reconRuns.configId, at: max(reconRuns.startedAt).as("at") }).from(reconRuns).where(scope).groupBy(reconRuns.configId).as("latest");
    const last = await tx.select({ id: reconRuns.configId, status: reconRuns.status, started: reconRuns.startedAt }).from(reconRuns)
      .innerJoin(latest, and(eq(latest.id, reconRuns.configId), eq(latest.at, reconRuns.startedAt))).where(scope);
    const out: Due[] = [];
    for (const p of pub) {
      const spec = ReconSpec.parse(p.spec), r = last.find((x) => x.id === p.configId);
      const lastClosed = days.find((x) => x.id === p.configId && x.status === "closed")?.d ?? null;
      const closing = days.find((x) => x.id === p.configId && x.status === "closing" && (!lastClosed || x.d > lastClosed))?.d;
      out.push({
        ...p, spec, firstDate: todayIn(first.get(p.configId) ?? now), lastClosed, lastSuccess: success.get(p.configId) ?? null,
        lastStarted: r?.started ?? null, lastFailed: r?.status === "failed",
        waiting: closing !== undefined && !(await moved(tx, p.spaceId, p.configId, spec, closing)) && now.getTime() < closeMoment(spec, closing).getTime() + spec.grace_minutes * 60_000,
      });
    }
    return out;
  }, on);
}

/**
 * A side the last run's intake of date `d` saw incomplete is now complete through the date's end: worth a run. (A
 * watermark cursor moves with every pull; a move within the date isn't.)
 */
async function moved(tx: InTx, spaceId: string, configId: string, spec: ReconSpec, d: string): Promise<boolean> {
  const seen = await seenOn(tx, spaceId, configId, d), end = endOfDay(d);
  const now = await tx.select({ id: sourceCursors.sourceId, ct: sourceCursors.completeThrough }).from(sourceCursors)
    .where(inArray(sourceCursors.sourceId, spec.sides.map((s) => s.source_id)));
  return spec.sides.some((s) => {
    const ct = now.find((x) => x.id === s.source_id)?.ct, was = seen?.[s.key];
    return (!was || new Date(was) < end) && !!ct && ct >= end;
  });
}

/**
 * The schedule's minute (recon.schedule): starts each due run (queued, its job on recon.tick or recon.daily) and alerts
 * on a stale recon (rules.ts staleNow) once per stale spell, then hourly (alertStale). A recon busy with another run is
 * left for the next minute. Answers the runs it started.
 */
export async function dispatch(on: Tx, now = new Date()): Promise<string[]> {
  const started: string[] = [];
  for (const c of await scheduled(on, now)) {
    const since = c.lastSuccess ?? new Date(`${c.firstDate}T00:00:00+07:00`);
    if (staleNow(c.spec, since, c.lastClosed, now) && (await alertStale(on, c.spaceId, c.configId, since, now))) {
      log.warn({ spaceId: c.spaceId, configId: c.configId, lastSuccess: c.lastSuccess?.toISOString() ?? null }, "recon is stale: no successful scheduled run in twice its interval");
    }
    const range = planRun(c.spec, c, now);
    if (!range) continue;
    const mode = c.spec.schedule.kind === "daily" ? "daily" : "tick";
    try {
      started.push(await withSpace({ spaceIds: [c.spaceId], userId: null }, async (tx) => {
        await claimConfig(tx, c.spaceId, c.configId);
        const id = Bun.randomUUIDv7();
        await createRun(tx, { spaceId: c.spaceId, configId: c.configId, versionId: c.versionId, mode, ...range, status: "queued", id, jobId: id });
        await send(tx, c.spaceId, c.configId, id, mode);
        return id;
      }, on));
    } catch (e) {
      // busy (another run, or its job still queued): the next minute; anything else (a source it can't read) is logged
      if (!(e instanceof ApiError && e.code === "invalid_state")) log.warn({ configId: c.configId, err: e instanceof ApiError ? e.message : errorDetail(e) }, "scheduled recon run not started");
    }
  }
  return started;
}

/**
 * Records a stale recon's alert at `now` when it is due: none yet, the last one before `since` (the last success: a new
 * stale spell) or ALERT_REPEAT_MS old. One conditional upsert, so of two dispatches at once one alerts (REC-F4).
 */
export async function alertStale(on: Tx, spaceId: string, configId: string, since: Date, now: Date): Promise<boolean> {
  const t = reconAlerts;
  const rows = await withSpace({ spaceIds: [spaceId], userId: null }, (tx) => tx.insert(t).values({ spaceId, configId, alertedAt: now })
    .onConflictDoUpdate({ target: [t.spaceId, t.configId], set: { alertedAt: now },
      setWhere: sql`${t.alertedAt} < ${since.toISOString()}::timestamptz or ${t.alertedAt} <= ${new Date(now.getTime() - ALERT_REPEAT_MS).toISOString()}::timestamptz` })
    .returning({ at: t.alertedAt }), on);
  return rows.length > 0;
}

/**
 * After a sweep broke items of closed dates `dates` (REC-FUT-17): the days of the last finalized live run covering each
 * date read again, so Today, Live day and the trend (which show that run's days) count the sweep's breaks too.
 */
export async function refreshCovering(on: Tx, k: { spaceId: string; configId: string }, dates: readonly string[]): Promise<void> {
  if (!dates.length) return;
  const r = reconRuns;
  const ids = new Set<string>();
  await withSpace({ spaceIds: [k.spaceId], userId: null }, async (tx) => {
    for (const d of dates) {
      const [run] = await tx.select({ id: r.id }).from(r)
        .where(and(eq(r.spaceId, k.spaceId), eq(r.configId, k.configId), ne(r.mode, "simulation"), isNull(r.baselineOf), eq(r.status, "succeeded"), isNotNull(r.days),
          sql`${d}::date between ${r.dateFrom} and ${r.dateTo}`))
        .orderBy(desc(r.finishedAt)).limit(1);
      if (run) ids.add(run.id);
    }
  }, on);
  for (const id of ids) await refreshRunDays(on, k.spaceId, id);
}

/**
 * The job of a live run, scheduled or manual (recon.tick / recon.daily / recon.heavy, data { spaceId, runId }): the run
 * (jobs.ts runJob), then, if it succeeded and isn't a simulation, the closed dates just before it once more (sweepClosed: what their close skipped, what this run took in
 * for them) and each of its dates whose close moment has passed, oldest first, until one waits or isn't due. Closes
 * judge under the published version (closeDay).
 */
export async function runScheduled(on: Tx, data: { spaceId: string; runId: string }, signal?: AbortSignal, now = () => new Date()): Promise<void> {
  if (!data.runId) return; // a minute job of the schedule's first home (recon.tick, before review) still queued
  await runJob(on, data, signal);
  const [run] = await withSpace({ spaceIds: [data.spaceId], userId: null },
    (tx) => tx.select().from(reconRuns).where(and(eq(reconRuns.spaceId, data.spaceId), eq(reconRuns.id, data.runId))), on);
  if (run?.status !== "succeeded" || run.mode === "simulation") return; // a simulation closes nothing
  const k = { spaceId: run.spaceId, configId: run.configId };
  const [v] = await withSpace({ spaceIds: [run.spaceId], userId: null },
    (tx) => tx.select({ spec: reconConfigVersions.spec }).from(reconConfigVersions).where(and(eq(reconConfigVersions.spaceId, run.spaceId), eq(reconConfigVersions.id, run.configVersionId))), on);
  const carry = await withSpace({ spaceIds: [run.spaceId], userId: null }, (tx) => effectiveCarry(tx, k, ReconSpec.parse(v!.spec).carry_over_days, run.dateFrom), on);
  const swept = await sweepClosed(on, k, addDays(run.dateFrom, -Math.max(carry, 1)), addDays(run.dateFrom, -1));
  await refreshCovering(on, k, swept.dates);
  for (let d = run.dateFrom; d <= run.dateTo; d = addDays(d, 1)) {
    const r = await closeDay(on, k, d, now());
    if (r === "closing" || r === "not_due") return;
  }
}
