// The schedule (spec §9, Task 6). One cron job, every minute on recon.tick (key "schedule", worker.ts), looks at every
// active recon with a published version and, from state alone (its closed days, its first publish, its last scheduled
// run: rules.ts planRun), starts the run that is due: `tick` for an interval recon (recon.tick), `daily` for a daily one
// (recon.daily). A run starts only through claimConfig, as a manual one does: one run of a config at a time, and a run
// whose worker died is failed there (reaper) before the next starts. A worker that was down catches up by itself: the
// next run covers every date since the last closed one. The run's job then closes each of its dates whose close moment
// has passed (breaks.ts closeDay), in order, and stops at a date that still waits for data.
//
// Chosen over a pg-boss schedule per config (scheduleEvery): a cron can't say "every 90 minutes", and a schedule per
// config would have to follow every publish, pause and retire; this job reads them as they are. ponytail: one job
// reads every config each minute; shard by space if that read grows past a few hundred milliseconds.
import { ReconSpec } from "@starterkit/shared/contracts/recon";
import { and, eq, inArray, max, min, ne, sql } from "drizzle-orm";
import type { Tx } from "../../kernel/db";
import { ApiError, errorDetail } from "../../kernel/errors";
import { log } from "../../kernel/log";
import { todayIn } from "../ingest";
import { reconConfigs, reconConfigVersions } from "../recon";
import { spaces, withSpace } from "../spaces";
import { closeDay } from "./breaks";
import { claimConfig, runJob, send } from "./jobs";
import { closeMoment, isStale, planRun } from "./rules";
import { reconDays, reconRuns } from "./schema";
import { addDays, createRun } from "./service";

const SCHEDULED = ["tick", "daily"] as const;

/** A recon the schedule looks at: its published version and what rules.ts planRun needs. */
type Due = { spaceId: string; configId: string; versionId: string; spec: ReconSpec; firstDate: string; lastClosed: string | null; lastStarted: Date | null; lastSuccess: Date | null };

/** Every active recon of an active space with a published version, with its schedule state (four queries in all). */
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
    const closed = new Map((await tx.select({ id: reconDays.configId, d: sql<string | null>`max(${reconDays.businessDate})::text` }).from(reconDays)
      .where(and(inArray(reconDays.spaceId, ids), inArray(reconDays.configId, cfgs), eq(reconDays.status, "closed"))).groupBy(reconDays.configId)).map((r) => [r.id, r.d]));
    const runs = await tx.select({ id: reconRuns.configId, started: max(reconRuns.startedAt), success: sql<string | null>`max(${reconRuns.finishedAt}) filter (where ${reconRuns.status} = 'succeeded')` })
      .from(reconRuns).where(and(inArray(reconRuns.spaceId, ids), inArray(reconRuns.configId, cfgs), inArray(reconRuns.mode, [...SCHEDULED]))).groupBy(reconRuns.configId);
    return pub.map((p): Due => {
      const r = runs.find((x) => x.id === p.configId);
      return {
        ...p, spec: ReconSpec.parse(p.spec), firstDate: todayIn(first.get(p.configId) ?? now), lastClosed: closed.get(p.configId) ?? null,
        lastStarted: r?.started ?? null, lastSuccess: r?.success ? new Date(r.success) : null,
      };
    });
  }, on);
}

/**
 * The schedule's minute (recon.tick, key "schedule"): starts each due run (queued, its job on recon.tick or
 * recon.daily) and logs each stale recon. A recon busy with another run is left for the next minute. Answers the runs
 * it started.
 */
export async function dispatch(on: Tx, now = new Date()): Promise<string[]> {
  const started: string[] = [];
  for (const c of await scheduled(on, now)) {
    if (isStale(c.spec, c.lastSuccess ?? new Date(`${c.firstDate}T00:00:00+07:00`), now)) {
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
 * The job of a scheduled run (recon.tick / recon.daily, data { spaceId, runId }): the run (jobs.ts runJob), then, if it
 * succeeded, each of its dates whose close moment has passed, oldest first, until one waits for data.
 */
export async function runScheduled(on: Tx, data: { spaceId: string; runId: string }, signal?: AbortSignal, now = () => new Date()): Promise<void> {
  await runJob(on, data, signal);
  const [run] = await withSpace({ spaceIds: [data.spaceId], userId: null },
    (tx) => tx.select().from(reconRuns).where(and(eq(reconRuns.spaceId, data.spaceId), eq(reconRuns.id, data.runId))), on);
  if (run?.status !== "succeeded") return;
  const k = { spaceId: run.spaceId, configId: run.configId, versionId: run.configVersionId };
  const [v] = await withSpace({ spaceIds: [run.spaceId], userId: null },
    (tx) => tx.select({ spec: reconConfigVersions.spec }).from(reconConfigVersions).where(and(eq(reconConfigVersions.spaceId, run.spaceId), eq(reconConfigVersions.id, run.configVersionId))), on);
  const spec = ReconSpec.parse(v!.spec);
  for (let d = run.dateFrom; d <= run.dateTo && closeMoment(spec, d) <= now(); d = addDays(d, 1)) {
    if ((await closeDay(on, k, d, now())) === "closing") return;
  }
}
