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
import { type ReconRunDto, ReconSpec, type RollbackRunDto, type RunRangeBody } from "@starterkit/shared/contracts/recon";
import { and, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import type { InTx, Tx } from "../../kernel/db";
import { ApiError, notFound } from "../../kernel/errors";
import { enqueue, type JobHandler, jobAlive, QUEUE_OPTIONS, type QueueName, QUEUES } from "../../kernel/jobs";
import { tryConfigLock } from "../../kernel/locks";
import { log } from "../../kernel/log";
import { recordActivity } from "../audit";
import type { Ctx } from "../auth";
import { discardDraft, draftToSimulate, markSimulated, reconConfigs, reconConfigVersions } from "../recon";
import { withSpace } from "../spaces";
import { currentDate } from "./rules";
import { dispatch, runScheduled } from "./schedule";
import { rollbackSet } from "./rollback";
import { reconDays, reconRuns } from "./schema";
import { backfillRun, createRun, execRun, failRun, projectDayClose, RANGE_MAX_DAYS, queueOf, RUN_INTERNAL_ERROR, RunAborted, type RunMode, runRange, runRow } from "./service";

/**
 * How long a run without a job (run in process: runRecon, a test) counts as under way: the longest a job may run.
 * Past it the reaper fails it like a run whose job is over.
 */
const NO_JOB_MAX_MS = QUEUE_OPTIONS[QUEUES.reconHeavy].expireInSeconds! * 1000;
import { changesSql } from "./sql/runs";
import { backfillStats, queueRunStats, statsJob, sweepStats } from "./stats";


/** A manual run over a signed-off business date (DEC-064: a signed day is frozen). */
export const SIGNED_DAY = "Some of these dates are signed off, so their items no longer change. Run dates that aren't signed off.";
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
 * The business dates of a request's body `b`: as given (checked before anything is read), or by default the date the
 * published version's schedule works on today (rules.ts currentDate: today − business_date_offset).
 */
const rangeOf = (b: RunRangeBody) => {
  const given = b.from || b.to ? runRange(b.from, b.to) : null;
  return (spec: unknown) => given ?? runRange(currentDate(ReconSpec.parse(spec), new Date()), undefined);
};

/** The latest signed-off business date of config `configId` within `range` (null when none): a signed day is frozen. */
async function signedIn(tx: InTx, spaceId: string, configId: string, range: { from: string; to: string }): Promise<string | null> {
  const [r] = await tx.select({ d: sql<string | null>`max(${reconDays.businessDate})::text` }).from(reconDays).where(and(eq(reconDays.spaceId, spaceId),
    eq(reconDays.configId, configId), isNotNull(reconDays.signedAt), sql`${reconDays.businessDate} between ${range.from}::date and ${range.to}::date`));
  return r?.d ?? null;
}

/**
 * POST …/recons/:configId/runs: a run of the published version over `b`'s business dates (rangeOf), queued; like every
 * live run it makes what stays unpaired unmatch (DEC-064). 404 recon, 409 no published version, a signed-off date in
 * the range or a run under way, 400 range.
 */
export async function requestRun(ctx: Ctx, configId: string, b: RunRangeBody): Promise<ReconRunDto> {
  const rangeIn = rangeOf(b);
  return inSpace(ctx, async (tx, spaceId) => {
    const [c] = await tx.select().from(reconConfigs).where(and(eq(reconConfigs.spaceId, spaceId), eq(reconConfigs.id, configId)));
    if (!c) throw notFound("recon");
    const [p] = await tx.select({ id: reconConfigVersions.id, version: reconConfigVersions.version, spec: reconConfigVersions.spec }).from(reconConfigVersions)
      .where(and(eq(reconConfigVersions.spaceId, spaceId), eq(reconConfigVersions.configId, configId), eq(reconConfigVersions.status, "published")));
    if (!p) throw new ApiError("invalid_state", "This recon has no published version yet. Approve one first.");
    const range = rangeIn(p.spec);
    if (await signedIn(tx, spaceId, configId, range)) throw new ApiError("day_closed", SIGNED_DAY);
    await claimConfig(tx, spaceId, configId);
    const id = Bun.randomUUIDv7();
    await createRun(tx, { spaceId, configId, versionId: p.id, mode: "manual", ...range, status: "queued", id, jobId: id });
    await recordActivity(tx, ctx, { action: "recon.run", target: { type: "recon", id: c.id, label: c.name }, after: { runId: id, version: p.version, ...range } });
    await send(tx, spaceId, configId, id, "manual");
    return runRow(tx, spaceId, configId, id);
  });
}

/**
 * POST …/runs/:runId/rollback (a space admin; rollback.ts): run `runId` and every live run after it rolled back, then
 * their dates run again: a rerun of the published version over them (from the first's start to the last's end),
 * queued with rollback_of = `runId`; its job does the rollback first. 404 recon or run; 400 a simulation, or dates past
 * RANGE_MAX_DAYS; 409 no published version, the run rolled back already or not ended, a signed-off date in the
 * range, a run under way. A signed-off carry-over date, or a change waiting for a decision, refuses it when the job runs
 * (the rerun fails with why).
 */
export async function requestRollback(ctx: Ctx, configId: string, runId: string): Promise<RollbackRunDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const [c] = await tx.select().from(reconConfigs).where(and(eq(reconConfigs.spaceId, spaceId), eq(reconConfigs.id, configId)));
    if (!c) throw notFound("recon");
    const [x] = await tx.select().from(reconRuns).where(and(eq(reconRuns.spaceId, spaceId), eq(reconRuns.configId, configId), eq(reconRuns.id, runId), isNull(reconRuns.baselineOf)));
    if (!x) throw notFound("run");
    if (x.mode === "simulation") throw new ApiError("bad_request", "A simulation changes no live items, so there is nothing to roll back.");
    if (x.rolledBackAt) throw new ApiError("invalid_state", "This run was rolled back already.");
    if (x.status === "queued" || x.status === "running") throw new ApiError("invalid_state", "This run hasn't ended yet. Roll it back once it ends.");
    const [p] = await tx.select({ id: reconConfigVersions.id, version: reconConfigVersions.version }).from(reconConfigVersions)
      .where(and(eq(reconConfigVersions.spaceId, spaceId), eq(reconConfigVersions.configId, configId), eq(reconConfigVersions.status, "published")));
    if (!p) throw new ApiError("invalid_state", "This recon has no published version to run its dates again. Approve one first.");
    const [set] = await tx.select({ n: sql<number>`count(*)::int`, from: sql<string>`min(${reconRuns.dateFrom})::text`, to: sql<string>`max(${reconRuns.dateTo})::text` })
      .from(reconRuns).where(rollbackSet(x));
    const range = { from: set!.from, to: set!.to };
    const days = Math.round((Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000) + 1;
    if (days > RANGE_MAX_DAYS) throw new ApiError("bad_request", `This run and the ones after it cover ${days} business dates; a rerun covers at most ${RANGE_MAX_DAYS}. Roll back a later run.`);
    const shut = await signedIn(tx, spaceId, configId, range);
    if (shut) throw new ApiError("day_closed", `Business date ${shut} is signed off, so what these runs did there stays. Roll back a run after it.`);
    await claimConfig(tx, spaceId, configId);
    const id = Bun.randomUUIDv7();
    await createRun(tx, { spaceId, configId, versionId: p.id, mode: "rerun", ...range, status: "queued", id, jobId: id, rollbackOf: x.id });
    await recordActivity(tx, ctx, {
      action: "recon.run_rollback", target: { type: "recon", id: c.id, label: c.name },
      after: { runId: x.id, startedAt: x.startedAt.toISOString(), runs: set!.n, rerunId: id, version: p.version, ...range },
    });
    await send(tx, spaceId, configId, id, "rerun");
    return { runs: set!.n, rerun: await runRow(tx, spaceId, configId, id) };
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
    const range = rangeIn(v.spec);
    await claimConfig(tx, spaceId, configId);
    const id = Bun.randomUUIDv7();
    await createRun(tx, { spaceId, configId, versionId, mode: "simulation", ...range, status: "queued", id, jobId: id });
    await recordActivity(tx, ctx, { action: "recon.simulate", target: { type: "recon", id: c.id, label: c.name }, after: { runId: id, version: v.version, specHash: v.specHash, ...range } });
    await send(tx, spaceId, configId, id, "simulation");
    return runRow(tx, spaceId, configId, id);
  });
}

/**
 * DELETE …/versions/:versionId (owner, 22 Nov: Cancel while editing a live recon): the draft's simulations (their
 * baselines, items and groups go with them, cascade), then the draft itself (recon's discardDraft, its activity entry),
 * in one transaction. 409 while one of its simulations is queued or running.
 */
export function discardDraftVersion(ctx: Ctx, configId: string, versionId: string): Promise<void> {
  return inSpace(ctx, async (tx, spaceId) => {
    const sims = and(eq(reconRuns.spaceId, spaceId), eq(reconRuns.configId, configId), eq(reconRuns.configVersionId, versionId), eq(reconRuns.mode, "simulation"));
    const busy = await tx.select({ id: reconRuns.id }).from(reconRuns).where(and(sims, inArray(reconRuns.status, ["queued", "running"])));
    if (busy.length) throw new ApiError("invalid_state", "A simulation of this draft is under way. Discard it once the simulation ends.");
    await tx.delete(reconRuns).where(sims);
    await discardDraft(tx, ctx, configId, versionId);
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
 * A run's job (runScheduled; `runner` = a test's own) and, also after a failure (what it committed counts), its dates
 * queued for the dashboard's rollup; the nightly sweep is the net.
 */
export async function runAndRefresh(on: Tx, d: { spaceId: string; runId: string }, signal?: AbortSignal, runner: typeof runScheduled = runScheduled): Promise<void> {
  try {
    await runner(on, d, signal);
  } finally {
    // a failure here is logged, never thrown: it must not replace the runner's own error (review T4)
    try {
      if (d.runId) await queueRunStats(on, d.spaceId, d.runId);
    } catch (e) {
      log.warn({ err: e, runId: d.runId }, "run dates not queued for the dashboard");
    }
  }
}

/** The engine's job handlers, on the worker's pool (src/worker.ts). */
export const engineHandlers = (on: Tx): Partial<Record<QueueName, JobHandler>> => {
  // a run (runAndRefresh); or a GET's backfill
  const run = async ({ data, signal }: { data: unknown; signal?: AbortSignal }) => {
    const d = data as { spaceId: string; runId: string; finalize?: boolean };
    // a GET found a succeeded run's days missing (before 0032, failed, older shape): write them (runDetail)
    if (d.finalize) return backfillRun(on, d.spaceId, d.runId);
    await runAndRefresh(on, d, signal);
  };
  return {
    [QUEUES.reconHeavy]: run,
    // the schedule's minute, and the runs it starts
    [QUEUES.reconSchedule]: async () => { await dispatch(on); },
    [QUEUES.reconTick]: run,
    [QUEUES.reconDaily]: run,
    // the dashboard's rollup: one (config, date), the nightly sweep, or the backfill at the worker's start
    [QUEUES.reconStats]: async ({ data }) => {
      const d = data as { spaceId: string; configId: string; date: string } | { sweep: true } | { backfill: true };
      await ("sweep" in d ? sweepStats(on) : "backfill" in d ? backfillStats(on) : statsJob(on, d));
    },
  };
};
