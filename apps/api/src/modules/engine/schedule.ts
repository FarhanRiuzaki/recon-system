// The schedule (spec §9, DEC-064). One cron job, every minute on its own queue recon.schedule (worker.ts), looks at
// every active recon with a published version and starts the run that is due (rules.ts planRun): its current business
// date (today − business_date_offset) once per slot of its window (from–to, every every_minutes). A window of more
// than one moment runs on recon.tick (`tick`), one of a single moment on recon.daily (`daily`). A run starts only
// through claimConfig, as a manual one does: one run of a config at a time, and a run whose worker died is failed there
// (reaper) before the next starts; a recon busy with another run gets the next minute. There is no day close: each run
// makes what stays unpaired unmatch, and the next runs pair it again within carry over; a date whose window a stopped
// worker missed is read by the next date's runs through carry over. A config whose last scheduled run failed waits
// (rules.ts backoffMs).
//
// Chosen over a pg-boss schedule per config (scheduleEvery): a cron can't say "every 90 minutes", and a schedule per
// config would have to follow every publish, pause and retire; this job reads them as they are. ponytail: one job
// reads every config each minute; shard by space if that read grows past a few hundred milliseconds.
import { ReconSpec } from "@starterkit/shared/contracts/recon";
import { and, eq, inArray, max, ne, sql } from "drizzle-orm";
import type { Tx } from "../../kernel/db";
import { ApiError, errorDetail } from "../../kernel/errors";
import { log } from "../../kernel/log";
import { reconConfigs, reconConfigVersions } from "../recon";
import { spaces, withSpace } from "../spaces";
import { claimConfig, runJob, send } from "./jobs";
import { ALERT_REPEAT_MS, planRun, type ScheduleState, staleNow } from "./rules";
import { reconAlerts, reconRuns } from "./schema";
import { createRun } from "./service";

const SCHEDULED = ["tick", "daily"] as const;

/** A recon the schedule looks at: its published version and what rules.ts planRun needs. */
type Due = ScheduleState & { spaceId: string; configId: string; versionId: string; spec: ReconSpec; lastSuccess: Date | null };

/** Every active recon of an active space with a published version, with its last scheduled run: a few queries for them all. */
async function scheduled(on: Tx): Promise<Due[]> {
  const ids = (await on.select({ id: spaces.id }).from(spaces).where(ne(spaces.status, "archived"))).map((s) => s.id);
  if (!ids.length) return [];
  return withSpace({ spaceIds: ids, userId: null }, async (tx) => {
    const pub = await tx.select({ spaceId: reconConfigVersions.spaceId, configId: reconConfigVersions.configId, versionId: reconConfigVersions.id, spec: reconConfigVersions.spec })
      .from(reconConfigVersions).innerJoin(reconConfigs, and(eq(reconConfigs.spaceId, reconConfigVersions.spaceId), eq(reconConfigs.id, reconConfigVersions.configId)))
      .where(and(inArray(reconConfigVersions.spaceId, ids), eq(reconConfigVersions.status, "published"), eq(reconConfigs.status, "active")));
    if (!pub.length) return [];
    const cfgs = pub.map((p) => p.configId);
    const scope = and(inArray(reconRuns.spaceId, ids), inArray(reconRuns.configId, cfgs), inArray(reconRuns.mode, [...SCHEDULED]));
    const success = new Map((await tx.select({ id: reconRuns.configId, at: max(reconRuns.finishedAt) }).from(reconRuns)
      .where(and(scope, eq(reconRuns.status, "succeeded"))).groupBy(reconRuns.configId)).map((r) => [r.id, r.at]));
    // the latest scheduled run of each config: when it started, and whether it failed (backoff)
    const latest = tx.select({ id: reconRuns.configId, at: max(reconRuns.startedAt).as("at") }).from(reconRuns).where(scope).groupBy(reconRuns.configId).as("latest");
    const last = await tx.select({ id: reconRuns.configId, status: reconRuns.status, started: reconRuns.startedAt }).from(reconRuns)
      .innerJoin(latest, and(eq(latest.id, reconRuns.configId), eq(latest.at, reconRuns.startedAt))).where(scope);
    return pub.map((p) => {
      const r = last.find((x) => x.id === p.configId);
      return { ...p, spec: ReconSpec.parse(p.spec), lastSuccess: success.get(p.configId) ?? null, lastStarted: r?.started ?? null, lastFailed: r?.status === "failed" };
    });
  }, on);
}

/**
 * The schedule's minute (recon.schedule): starts each due run (queued, its job on recon.tick or recon.daily) and alerts
 * on a stale recon (rules.ts staleNow) once per stale spell, then hourly (alertStale). A recon busy with another run is
 * left for the next minute. Answers the runs it started.
 */
export async function dispatch(on: Tx, now = new Date()): Promise<string[]> {
  const started: string[] = [];
  for (const c of await scheduled(on)) {
    if (staleNow(c.spec, c.lastSuccess, now) && (await alertStale(on, c.spaceId, c.configId, c.lastSuccess ?? new Date(0), now))) {
      log.warn({ spaceId: c.spaceId, configId: c.configId, lastSuccess: c.lastSuccess?.toISOString() ?? null }, "recon is stale: no successful scheduled run in twice its interval");
    }
    const range = planRun(c.spec, c, now);
    if (!range) continue;
    const mode = c.spec.schedule.from === c.spec.schedule.to ? "daily" : "tick";
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

/** The job of a live run, scheduled or manual (recon.tick / recon.daily / recon.heavy, data { spaceId, runId }): the run (jobs.ts runJob). */
export async function runScheduled(on: Tx, data: { spaceId: string; runId: string }, signal?: AbortSignal): Promise<void> {
  if (!data.runId) return; // a minute job of the schedule's first home (recon.tick, before review) still queued
  await runJob(on, data, signal);
}
