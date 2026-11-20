// Runs and simulations as jobs (Plan 3 Task 3, spec §9–§10, spike S2). A request (POST …/runs, POST
// …/versions/:versionId/simulate) writes the run row, status queued and pinned to its version, with its activity entry
// in one transaction, then queues job id = run id on recon.heavy keyed by the config; the answer is that row, and the
// screen polls GET …/runs/:runId. The worker's handler runs it on the worker pool (workerDb, JOB_STATEMENT_TIMEOUT_MS),
// never on the API's 5 s pool.
//
// One run of a config at a time: a request takes configLock without waiting (tryConfigLock: a step of another run holds
// it now) and refuses while the config has a run queued or running, so two runs of one config never interleave, whatever
// queue they are on (Task 6's ticks start theirs through createRun the same way). A run whose job is over while the run
// is not (its worker died past its retries, or the job never got queued) is failed by that same check: the reaper runs at
// the next request of the config, not on a timer.
import type { ReconRunDto, RunRangeBody } from "@starterkit/shared/contracts/recon";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { db, type InTx, type Tx } from "../../kernel/db";
import { ApiError, notFound } from "../../kernel/errors";
import { enqueue, type JobHandler, jobAlive, type QueueName, QUEUES } from "../../kernel/jobs";
import { tryConfigLock } from "../../kernel/locks";
import { recordActivity } from "../audit";
import type { Ctx } from "../auth";
import { draftToSimulate, markSimulated, reconConfigs, reconConfigVersions } from "../recon";
import { withSpace } from "../spaces";
import { reconRuns } from "./schema";
import { createRun, execRun, failRun, RUN_INTERNAL_ERROR, type RunMode, runRange, runRow } from "./service";
import { changesSql } from "./sql/runs";

/** The queue a run of `mode` goes to (spec §9 table): ticks and daily runs have their own (Task 6); the rest is heavy. */
const queueOf = (mode: string): QueueName => (mode === "tick" ? QUEUES.reconTick : mode === "daily" ? QUEUES.reconDaily : QUEUES.reconHeavy);

export const RUN_BUSY = "This recon is already running. Wait for that run to finish, then start another.";
/** A run the reaper finds without a live job. */
export const RUN_STOPPED = "The run stopped before it finished. Run it again.";

/**
 * Claims config `configId` for one new run in `tx`: its lock without waiting, then every run of it still queued or
 * running is either alive (its job may still run: 409 RUN_BUSY) or failed now with RUN_STOPPED, with the published
 * version's simulation it started (baseline_of). A run without a job (run in process) counts as alive.
 */
async function claimConfig(tx: InTx, spaceId: string, configId: string): Promise<void> {
  if (!(await tryConfigLock(tx, configId))) throw new ApiError("invalid_state", RUN_BUSY);
  const active = await tx.select({ id: reconRuns.id, mode: reconRuns.mode, jobId: reconRuns.jobId }).from(reconRuns)
    .where(and(eq(reconRuns.spaceId, spaceId), eq(reconRuns.configId, configId), inArray(reconRuns.status, ["queued", "running"]), isNull(reconRuns.baselineOf)));
  for (const r of active) {
    if (!r.jobId || (await jobAlive(queueOf(r.mode), r.jobId))) throw new ApiError("invalid_state", RUN_BUSY);
    await tx.update(reconRuns).set({ status: "failed", error: RUN_STOPPED, finishedAt: sql`now()` })
      .where(and(eq(reconRuns.spaceId, spaceId), inArray(reconRuns.status, ["queued", "running"]), sql`(${reconRuns.id} = ${r.id} or ${reconRuns.baselineOf} = ${r.id})`));
  }
}

/** Queues run `runId` (job id = run id); a run that can't be queued is failed and the request answers why. */
async function send(spaceId: string, configId: string, runId: string, mode: RunMode): Promise<void> {
  let job: string | null;
  try {
    job = await enqueue(queueOf(mode), { spaceId, runId }, { key: configId, id: runId });
  } catch (e) {
    await failRun(db, spaceId, runId, RUN_INTERNAL_ERROR);
    throw e;
  }
  if (!job) {
    await failRun(db, spaceId, runId, RUN_BUSY);
    throw new ApiError("invalid_state", RUN_BUSY);
  }
}

const inSpace = <T>(ctx: Ctx, fn: (tx: InTx, spaceId: string) => Promise<T>) =>
  withSpace({ spaceIds: [ctx.space!.id], userId: ctx.user.id }, (tx) => fn(tx, ctx.space!.id));

/**
 * POST …/recons/:configId/runs: a run of the published version over `b`'s business dates (a day by default: today;
 * the last closed day once days close, Task 6), queued. 404 recon, 409 no published version or a run under way, 400 range.
 */
export async function requestRun(ctx: Ctx, configId: string, b: RunRangeBody): Promise<ReconRunDto> {
  const runId = await inSpace(ctx, async (tx, spaceId) => {
    const [c] = await tx.select().from(reconConfigs).where(and(eq(reconConfigs.spaceId, spaceId), eq(reconConfigs.id, configId)));
    if (!c) throw notFound("recon");
    const [p] = await tx.select({ id: reconConfigVersions.id, version: reconConfigVersions.version }).from(reconConfigVersions)
      .where(and(eq(reconConfigVersions.spaceId, spaceId), eq(reconConfigVersions.configId, configId), eq(reconConfigVersions.status, "published")));
    if (!p) throw new ApiError("invalid_state", "This recon has no published version yet. Approve one first.");
    const range = runRange(b.from, b.to);
    await claimConfig(tx, spaceId, configId);
    const id = Bun.randomUUIDv7();
    await createRun(tx, { spaceId, configId, versionId: p.id, mode: "manual", ...range, status: "queued", id, jobId: id });
    await recordActivity(tx, ctx, { action: "recon.run", target: { type: "recon", id: c.id, label: c.name }, after: { runId: id, version: p.version, ...range } });
    return id;
  });
  await send(ctx.space!.id, configId, runId, "manual");
  return inSpace(ctx, (tx, spaceId) => runRow(tx, spaceId, configId, runId));
}

/**
 * POST …/versions/:versionId/simulate: a simulation of draft `versionId` over `b`'s business dates, queued; the caller
 * becomes a contributor of the draft. Its job also simulates the published version over the same dates and writes
 * the changes between the two, then marks the draft simulated (submit opens). 404, 409 not a draft or a run under way.
 */
export async function requestSimulation(ctx: Ctx, configId: string, versionId: string, b: RunRangeBody): Promise<ReconRunDto> {
  const runId = await inSpace(ctx, async (tx, spaceId) => {
    const { config: c, version: v } = await draftToSimulate(tx, ctx, configId, versionId);
    const range = runRange(b.from, b.to);
    await claimConfig(tx, spaceId, configId);
    const id = Bun.randomUUIDv7();
    await createRun(tx, { spaceId, configId, versionId, mode: "simulation", ...range, status: "queued", id, jobId: id });
    await recordActivity(tx, ctx, { action: "recon.simulate", target: { type: "recon", id: c.id, label: c.name }, after: { runId: id, version: v.version, specHash: v.specHash, ...range } });
    return id;
  });
  await send(ctx.space!.id, configId, runId, "simulation");
  return inSpace(ctx, (tx, spaceId) => runRow(tx, spaceId, configId, runId));
}

type RunRow = typeof reconRuns.$inferSelect;

/**
 * The published version's simulation over draft simulation `s`'s dates: the one it started already (a retried job), or
 * a new one (null when no version is published). Its spec is the published version's now; the draft's run is pinned,
 * this one is pinned when it starts.
 */
async function baselineOf(on: Tx, s: RunRow): Promise<string | null> {
  return withSpace({ spaceIds: [s.spaceId], userId: null }, async (tx) => {
    const [had] = await tx.select({ id: reconRuns.id }).from(reconRuns).where(and(eq(reconRuns.spaceId, s.spaceId), eq(reconRuns.baselineOf, s.id)));
    if (had) return had.id;
    const [p] = await tx.select({ id: reconConfigVersions.id }).from(reconConfigVersions)
      .where(and(eq(reconConfigVersions.spaceId, s.spaceId), eq(reconConfigVersions.configId, s.configId), eq(reconConfigVersions.status, "published")));
    if (!p) return null;
    return createRun(tx, {
      spaceId: s.spaceId, configId: s.configId, versionId: p.id, mode: "simulation", from: s.dateFrom, to: s.dateTo, status: "running", jobId: s.jobId, baselineOf: s.id,
    });
  }, on);
}

/**
 * In the transaction that marks draft simulation `s` succeeded: its changes against `baseline`, the draft's simulated
 * hash, and retention. Retention (one simulation per version): the simulations of this version older than `s` are
 * deleted, and with them (cascade) their published-version simulations, items, groups and changes; other versions keep
 * their latest. ponytail: one statement deletes them all; per chunk if simulations grow to S1 volume.
 */
async function finishSimulation(tx: InTx, s: RunRow, baseline: string | null): Promise<void> {
  await tx.execute(changesSql(s.spaceId, s.id, baseline));
  await markSimulated(tx, s.spaceId, s.configVersionId, s.specHash!);
  await tx.delete(reconRuns).where(and(
    eq(reconRuns.spaceId, s.spaceId), eq(reconRuns.configId, s.configId), eq(reconRuns.configVersionId, s.configVersionId), eq(reconRuns.mode, "simulation"),
    isNull(reconRuns.baselineOf), ne(reconRuns.id, s.id), inArray(reconRuns.status, ["succeeded", "failed"]),
  ));
}

const runOf = (on: Tx, spaceId: string, runId: string) =>
  withSpace({ spaceIds: [spaceId], userId: null }, async (tx) => (await tx.select().from(reconRuns).where(and(eq(reconRuns.spaceId, spaceId), eq(reconRuns.id, runId))))[0], on);

/**
 * The job of a run (recon.heavy, data { spaceId, runId }). A run over already (a retry after it ended) is left alone; a
 * run that fails is marked failed by execRun and the job completes (the run row says why; a person runs it again). Only
 * a failure that left the run unmarked (the database gone) throws, so pg-boss retries and the run goes on after its
 * last committed step.
 */
export async function runJob(on: Tx, data: { spaceId: string; runId: string }): Promise<void> {
  const run = await runOf(on, data.spaceId, data.runId);
  if (!run || run.status === "succeeded" || run.status === "failed") return;
  try {
    if (run.mode !== "simulation" || run.baselineOf) {
      await execRun(on, run.spaceId, run.id);
      return;
    }
    const baseline = await baselineOf(on, run).catch(async (e: unknown) => {
      await failRun(on, run.spaceId, run.id, e instanceof ApiError ? e.message : RUN_INTERNAL_ERROR);
      throw e;
    });
    if (baseline) {
      await execRun(on, run.spaceId, baseline).catch(() => undefined);
      const b = await runOf(on, run.spaceId, baseline);
      if (b?.status !== "succeeded") {
        await failRun(on, run.spaceId, run.id, b?.error ? `The published version's run over the same dates failed: ${b.error}` : RUN_INTERNAL_ERROR);
        return;
      }
    }
    await execRun(on, run.spaceId, run.id, (tx) => finishSimulation(tx, run, baseline));
  } catch (e) {
    if ((await runOf(on, data.spaceId, data.runId))?.status !== "failed") throw e;
  }
}

/** The engine's job handlers, on the worker's pool (src/worker.ts). */
export const engineHandlers = (on: Tx): Partial<Record<QueueName, JobHandler>> => ({
  [QUEUES.reconHeavy]: ({ data }) => runJob(on, data as { spaceId: string; runId: string }),
});
