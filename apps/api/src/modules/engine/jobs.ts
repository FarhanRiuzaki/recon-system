// Runs and simulations as jobs (Plan 3 Task 3, spec §9–§10, spike S2). A request (POST …/runs, POST
// …/versions/:versionId/simulate) writes the run row, status queued and pinned to its version, its activity entry and
// its job (id = run id, recon.heavy, keyed by the config; pg-boss writes it in the same transaction) in one
// transaction: the row never exists without its job. The answer is that row, and the screen polls GET …/runs/:runId. The worker's handler runs it on the worker pool (workerDb, JOB_STATEMENT_TIMEOUT_MS),
// never on the API's 5 s pool.
//
// One run of a config at a time: a request takes configLock without waiting (tryConfigLock: a step of another run holds
// it now) and refuses while the config has a run queued or running, so two runs of one config never interleave, whatever
// queue they are on (Task 6's ticks start theirs through claimConfig the same way). A run whose job is over while the run
// is not (its worker died past its retries) is failed by that same check: the reaper runs at the next request of the
// config, not on a timer.
import type { ReconRunDto, RunRangeBody } from "@starterkit/shared/contracts/recon";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { InTx, Tx } from "../../kernel/db";
import { ApiError, notFound } from "../../kernel/errors";
import { enqueue, type JobHandler, jobAlive, QUEUE_OPTIONS, type QueueName, QUEUES } from "../../kernel/jobs";
import { tryConfigLock } from "../../kernel/locks";
import { recordActivity } from "../audit";
import { todayIn } from "../ingest";
import type { Ctx } from "../auth";
import { draftToSimulate, markSimulated, reconConfigs, reconConfigVersions } from "../recon";
import { withSpace } from "../spaces";
import { lastClosedDay } from "./breaks";
import { LOOKBACK_DAYS } from "./rules";
import { dispatch, runScheduled } from "./schedule";
import { reconDays, reconRuns } from "./schema";
import { addDays, backfillRun, closedDates, createRun, execRun, failRun, projectDayClose, refreshRunDays, RUN_INTERNAL_ERROR, RunAborted, type RunMode, runRange, runRow } from "./service";

/**
 * How long a run without a job (run in process: runRecon, a test) counts as under way: the longest a job may run.
 * Past it the reaper fails it like a run whose job is over.
 */
const NO_JOB_MAX_MS = QUEUE_OPTIONS[QUEUES.reconHeavy].expireInSeconds! * 1000;
import { changesSql } from "./sql/runs";

/** The queue a run of `mode` goes to (spec §9 table): ticks and daily runs have their own (Task 6); the rest is heavy. */
const queueOf = (mode: string): QueueName => (mode === "tick" ? QUEUES.reconTick : mode === "daily" ? QUEUES.reconDaily : QUEUES.reconHeavy);

/** A manual run over a closed business date. */
export const CLOSED_DAY = "Some of these dates are already closed. Run dates after the last closed day.";
export const RUN_BUSY = "This recon is already running. Wait for that run to finish, then start another.";
/** A run the reaper finds without a live job. */
export const RUN_STOPPED = "The run stopped before it finished. Run it again.";

/**
 * Claims config `configId` for one new run in `tx`: its lock without waiting, then every run of it still queued or
 * running is either alive (its job may still run: 409 RUN_BUSY) or failed now with RUN_STOPPED, with the published
 * version's simulation it started (baseline_of). A run without a job counts as alive for NO_JOB_MAX_MS.
 */
export async function claimConfig(tx: InTx, spaceId: string, configId: string): Promise<void> {
  if (!(await tryConfigLock(tx, configId))) throw new ApiError("invalid_state", RUN_BUSY);
  const active = await tx.select({ id: reconRuns.id, mode: reconRuns.mode, jobId: reconRuns.jobId, startedAt: reconRuns.startedAt }).from(reconRuns)
    .where(and(eq(reconRuns.spaceId, spaceId), eq(reconRuns.configId, configId), inArray(reconRuns.status, ["queued", "running"]), isNull(reconRuns.baselineOf)));
  for (const r of active) {
    const alive = r.jobId ? await jobAlive(queueOf(r.mode), r.jobId) : Date.now() - r.startedAt.getTime() < NO_JOB_MAX_MS;
    if (alive) throw new ApiError("invalid_state", RUN_BUSY);
    await tx.update(reconRuns).set({ status: "failed", error: RUN_STOPPED, finishedAt: sql`now()` })
      .where(and(eq(reconRuns.spaceId, spaceId), inArray(reconRuns.status, ["queued", "running"]), sql`(${reconRuns.id} = ${r.id} or ${reconRuns.baselineOf} = ${r.id})`));
  }
}

/** Queues run `runId` (job id = run id) in `tx`, with its row; null from pg-boss (a job of the config waits) is 409. */
export async function send(tx: InTx, spaceId: string, configId: string, runId: string, mode: RunMode): Promise<void> {
  if (!(await enqueue(queueOf(mode), { spaceId, runId }, { key: configId, id: runId, tx }))) throw new ApiError("invalid_state", RUN_BUSY);
}

const inSpace = <T>(ctx: Ctx, fn: (tx: InTx, spaceId: string) => Promise<T>) =>
  withSpace({ spaceIds: [ctx.space!.id], userId: ctx.user.id }, (tx) => fn(tx, ctx.space!.id));

/**
 * The business dates of a request's body `b`: as given (checked before anything is read), or by default one day, the
 * day after the last closed one within the last 30 days (not past today), else today (Asia/Jakarta). A closed day is
 * never run again from here (Captain: that is a rerun with approval, REC-FUT-16).
 */
const rangeOf = (b: RunRangeBody) => {
  const given = b.from || b.to ? runRange(b.from, b.to) : null;
  return async (tx: InTx, spaceId: string, configId: string) => {
    if (given) return given;
    const today = todayIn(new Date());
    const closed = await lastClosedDay(tx, spaceId, configId, addDays(today, -LOOKBACK_DAYS));
    return runRange(closed && closed < today ? addDays(closed, 1) : today, undefined);
  };
};

/**
 * POST …/recons/:configId/runs: a run of the published version over `b`'s business dates (rangeOf), queued; its job
 * closes the dates past their close moment as a scheduled run does (runScheduled). 404 recon, 409 no published
 * version, a closed date in the range or a run under way, 400 range.
 */
export async function requestRun(ctx: Ctx, configId: string, b: RunRangeBody): Promise<ReconRunDto> {
  const rangeIn = rangeOf(b);
  return inSpace(ctx, async (tx, spaceId) => {
    const [c] = await tx.select().from(reconConfigs).where(and(eq(reconConfigs.spaceId, spaceId), eq(reconConfigs.id, configId)));
    if (!c) throw notFound("recon");
    const [p] = await tx.select({ id: reconConfigVersions.id, version: reconConfigVersions.version }).from(reconConfigVersions)
      .where(and(eq(reconConfigVersions.spaceId, spaceId), eq(reconConfigVersions.configId, configId), eq(reconConfigVersions.status, "published")));
    if (!p) throw new ApiError("invalid_state", "This recon has no published version yet. Approve one first.");
    const range = await rangeIn(tx, spaceId, configId);
    const [shut] = await tx.select({ d: sql<string>`max(${reconDays.businessDate})::text` }).from(reconDays).where(and(eq(reconDays.spaceId, spaceId),
      eq(reconDays.configId, configId), eq(reconDays.status, "closed"), sql`${reconDays.businessDate} between ${range.from}::date and ${range.to}::date`));
    if (shut?.d) throw new ApiError("invalid_state", CLOSED_DAY);
    await claimConfig(tx, spaceId, configId);
    const id = Bun.randomUUIDv7();
    await createRun(tx, { spaceId, configId, versionId: p.id, mode: "manual", ...range, status: "queued", id, jobId: id });
    await recordActivity(tx, ctx, { action: "recon.run", target: { type: "recon", id: c.id, label: c.name }, after: { runId: id, version: p.version, ...range } });
    await send(tx, spaceId, configId, id, "manual");
    return runRow(tx, spaceId, configId, id);
  });
}

/**
 * POST …/versions/:versionId/simulate: a simulation of draft `versionId` over `b`'s business dates, queued; the caller
 * becomes a contributor of the draft. Its job also simulates the published version over the same dates and writes
 * the changes between the two, then marks the draft simulated (submit opens). 404, 409 not a draft or a run under way.
 */
export async function requestSimulation(ctx: Ctx, configId: string, versionId: string, b: RunRangeBody): Promise<ReconRunDto> {
  const rangeIn = rangeOf(b);
  return inSpace(ctx, async (tx, spaceId) => {
    const { config: c, version: v } = await draftToSimulate(tx, ctx, configId, versionId);
    const range = await rangeIn(tx, spaceId, configId);
    await claimConfig(tx, spaceId, configId);
    const id = Bun.randomUUIDv7();
    await createRun(tx, { spaceId, configId, versionId, mode: "simulation", ...range, status: "queued", id, jobId: id });
    await recordActivity(tx, ctx, { action: "recon.simulate", target: { type: "recon", id: c.id, label: c.name }, after: { runId: id, version: v.version, specHash: v.specHash, ...range } });
    await send(tx, spaceId, configId, id, "simulation");
    return runRow(tx, spaceId, configId, id);
  });
}

type RunRow = typeof reconRuns.$inferSelect;

/**
 * The published version's simulation over draft simulation `s`'s dates: the one it started already (a retried job), or
 * a new one (null when no version is published). Its spec is the published version's now; the draft's run is pinned,
 * this one is pinned when it starts.
 */
async function baselineOf(on: Tx, s: RunRow): Promise<string | null> {
  return withSpace({ spaceIds: [s.spaceId], userId: null }, async (tx) => {
    // the draft's run row locked: a second delivery waits here, then finds the baseline the first made
    await tx.select({ id: reconRuns.id }).from(reconRuns).where(and(eq(reconRuns.spaceId, s.spaceId), eq(reconRuns.id, s.id))).for("update");
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
 * In the transaction that marks draft simulation `s` succeeded: its changes against `baseline`, its projection of day
 * close (stored in its counters), the draft's simulated hash, and retention. Retention (one simulation per version): the simulations of this version older than `s` are
 * deleted, and with them (cascade) their published-version simulations, items, groups and changes; other versions keep
 * their latest. ponytail: one statement deletes them all; per chunk if simulations grow to S1 volume.
 */
async function finishSimulation(tx: InTx, s: RunRow, baseline: string | null): Promise<void> {
  await tx.execute(changesSql(s.spaceId, s.id, baseline));
  const projection = await projectDayClose(tx, s);
  await tx.update(reconRuns).set({ counters: sql`${reconRuns.counters} || ${JSON.stringify({ projection })}::text::jsonb` })
    .where(and(eq(reconRuns.spaceId, s.spaceId), eq(reconRuns.id, s.id)));
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
export async function runJob(on: Tx, data: { spaceId: string; runId: string }, signal?: AbortSignal): Promise<void> {
  const run = await runOf(on, data.spaceId, data.runId);
  if (!run || run.status === "succeeded" || run.status === "failed") return;
  try {
    if (run.mode !== "simulation" || run.baselineOf) {
      await execRun(on, run.spaceId, run.id, { signal });
      return;
    }
    const baseline = await baselineOf(on, run).catch(async (e: unknown) => {
      await failRun(on, run.spaceId, run.id, e instanceof ApiError ? e.message : RUN_INTERNAL_ERROR);
      throw e;
    });
    if (baseline) {
      await execRun(on, run.spaceId, baseline, { signal }).catch((e: unknown) => {
        if (e instanceof RunAborted) throw e;
      });
      const b = await runOf(on, run.spaceId, baseline);
      if (b?.status !== "succeeded") {
        await failRun(on, run.spaceId, run.id, b?.error ? `The published version's run over the same dates failed: ${b.error}` : RUN_INTERNAL_ERROR);
        return;
      }
    }
    await execRun(on, run.spaceId, run.id, { signal, finish: (tx) => finishSimulation(tx, run, baseline) });
  } catch (e) {
    if ((await runOf(on, data.spaceId, data.runId))?.status !== "failed") throw e;
  }
}

/**
 * A run's job (runScheduled: the run, then its due dates closed) and, when that closed one of its dates, its days read
 * again so they show what the close made, also when runScheduled throws after closing some (a tick that closes nothing
 * reads nothing again). `runner` = runScheduled (a test passes its own).
 */
export async function runAndRefresh(on: Tx, d: { spaceId: string; runId: string }, signal?: AbortSignal, runner: typeof runScheduled = runScheduled): Promise<void> {
  const before = d.runId ? await closedDates(on, d.spaceId, d.runId) : 0;
  try {
    await runner(on, d, signal);
  } finally {
    if (d.runId && (await closedDates(on, d.spaceId, d.runId)) > before) await refreshRunDays(on, d.spaceId, d.runId);
  }
}

/** The engine's job handlers, on the worker's pool (src/worker.ts). */
export const engineHandlers = (on: Tx): Partial<Record<QueueName, JobHandler>> => {
  // a run and its due dates closed, its days read again when that closed one (runAndRefresh); or a GET's backfill
  const run = async ({ data, signal }: { data: unknown; signal?: AbortSignal }) => {
    const d = data as { spaceId: string; runId: string; finalize?: boolean };
    // a GET found a succeeded run's days missing (before 0032, failed, older shape): write them (runDetail)
    if (d.finalize) return backfillRun(on, d.spaceId, d.runId);
    await runAndRefresh(on, d, signal);
  };
  return {
    // a manual run closes its due dates as a scheduled one does (Captain: day close doesn't depend on what started the run)
    [QUEUES.reconHeavy]: run,
    // the schedule's minute, and the runs it starts
    [QUEUES.reconSchedule]: async () => { await dispatch(on); },
    [QUEUES.reconTick]: run,
    [QUEUES.reconDaily]: run,
  };
};
