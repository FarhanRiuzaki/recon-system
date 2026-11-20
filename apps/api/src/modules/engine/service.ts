// The engine (spec §8–§10): a run of one config version over business dates, set-based in PostgreSQL (spike S1). The
// run row commits first (createRun: the API's request queues it, runRecon starts it at once); then execRun takes each
// business date D of the range under withSpace scoped to the config's space (a source shared to it is read through the
// records policies, DEC-042) and configLock: intake of each side's records of D − carry_over_days … D (a transaction per
// side, marker `intake_done`), fresh planner statistics between (sql/runs.ts analyzeSql, short transactions of their
// own), then the passes in order over open items of that window only with the run's counters and `done_through` = D
// (the step's marker). A failed transaction rolls back alone and marks the run failed. A step run again finds nothing
// new: intake is once per record, passes read open items only, so a rerun adds no group and loses no item (Review
// Focus 3); a job retried, or delivered twice, goes on after the markers with the counters the run row holds.
//
// A run is pinned to its version (Focus 5): execRun reads the version the run row names, whatever is published since;
// only createRun asks for the published one. A draft's simulation pins its spec hash too: a draft edited before the
// simulation ran fails it ("changed after").
//
// A pass's choice is in sql/pass.ts: a pass of equalities only pairs per key in order when both sides hold as many
// (one statement); another pass takes mutual unique best pairs, repeated while it pairs (taking a pair can make another
// pair the unique best); then the ties go to on_ambiguous: break (sql/breaks.ts) or suggest. Suggested groups never
// count as matched (DEC-046): their items stay `suggested`, outside later passes, counted open by match rate. Before
// the passes, a step closes the window's open items whose record no longer counts (intake.ts closeReplacedSql), so the
// open counters count current records only.
import { ReconSpec } from "@starterkit/shared/contracts/recon";
import { recordFields } from "@starterkit/shared/recon";
import type { Page } from "@starterkit/shared/contracts/common";
import type { ReconRunDto, ReconRunItemDto, ReconRunItemQuery, ReconRunListQuery, ReconSimChangeDto, ReconSimChangeQuery } from "@starterkit/shared/contracts/recon";
import { type GroupKind, type ItemStatus, RUN_RANGE_MAX_DAYS, type RunMode, type RunStatus, type SimChange } from "@starterkit/shared/recon";
import { and, asc, count, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { InTx, Tx } from "../../kernel/db";
import { ApiError, errorDetail, notFound } from "../../kernel/errors";
import { log } from "../../kernel/log";
import { configLock } from "../../kernel/locks";
import { one as countOne, pageQuery, sortSql } from "../../kernel/pagination";
import { ensureMonthPartitions } from "../../kernel/partitions";
import type { Ctx } from "../auth";
import { currentRecord, records, todayIn } from "../ingest";
import { checkReconSpec, reconConfigs, reconConfigVersions } from "../recon";
import { readableSources } from "../sources";
import { withSpace } from "../spaces";
import { matchGroups, matchMembers, reconItems, reconRuns, reconSimChanges } from "./schema";
import { groupBreakSql, tieBreakSql } from "./sql/breaks";
import { closeReplacedSql, intakeSql } from "./sql/intake";
import { analyzeSql } from "./sql/runs";
import { acceptSql, equalitiesOnly, fifoSql, groupAcceptSql, type SideRef, type StepCtx, tieSuggestSql } from "./sql/pass";

export type { RunMode };
/** What a pass did over the run: groups it accepted, groups it suggested, items it broke as ambiguous. */
export type PassCounters = { matched: number; suggested: number; broken: number };
/**
 * A run's counters: items taken in per side, items closed because their record was replaced, per pass (by number), and
 * items still open per side in the window after.
 */
export type RunCounters = {
  intake: { a: number; b: number }; replaced: { a: number; b: number }; passes: Record<string, PassCounters>; open: { a: number; b: number };
};
export type RunInput = {
  spaceId: string; configId: string; versionId: string; mode: RunMode;
  /** Business dates (yyyy-mm-dd), at most RANGE_MAX_DAYS; both default to today in Asia/Jakarta. */
  from?: string; to?: string;
};
export type RunSummary = { runId: string; counters: RunCounters };

/** The longest range one run covers (Plan 3 Task 3: a day by default, 31 at most). */
export const RANGE_MAX_DAYS = RUN_RANGE_MAX_DAYS;
/**
 * Rounds of a pass's choice in one step. ponytail: each round takes at least one pair, so a key doubled k times on both
 * sides needs k tie rounds; past this the rest waits for the next run. Raise it, or pair ties by ROW_NUMBER in one
 * statement, if real duplicates run deeper.
 */
const ROUNDS_MAX = 50;

const DAY = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;

type Loaded = { spec: ReconSpec; sides: [SideRef, SideRef] };

/**
 * The sides of `spec` as space `spaceId` reads their sources; refused when a side's source is not readable here or the
 * spec's check fails (every field on the sides' whitelists).
 */
async function load(tx: InTx, spaceId: string, spec: ReconSpec): Promise<Loaded> {
  const found = await readableSources(tx, spaceId, spec.sides.map((s) => s.source_id));
  const sides = spec.sides.map((s) => {
    const src = found.get(s.source_id);
    if (!src?.spec) throw new ApiError("bad_request", `Side ${s.key.toUpperCase()}: this space can't read a published version of its source.`);
    return { key: s.key, sourceSpaceId: src.spaceId, sourceId: s.source_id, fields: recordFields(src.spec), negate: s.amount_sign === "negate", spec: src.spec };
  });
  const check = checkReconSpec(spec, [{ spec: sides[0]!.spec, currencies: [] }, { spec: sides[1]!.spec, currencies: [] }]);
  if (check.errors.length) throw new ApiError("bad_request", check.errors[0]!);
  const [a, b] = sides.map(({ spec: _, ...s }): SideRef => s);
  return { spec, sides: [a!, b!] };
}

/** Runs `q` (a compiled statement answering one row) on `tx`. */
const one = async <T>(tx: InTx, q: SQL) => ((await tx.execute(q)) as unknown as T[])[0]!;

/** One pass over the step's window: its choice repeated while it pairs, then its ties per on_ambiguous. */
async function runPass(tx: InTx, c: StepCtx, p: ReconSpec["passes"][number], out: PassCounters): Promise<void> {
  const bump = (kind: "auto" | "suggested", n: number) => { if (kind === "auto") out.matched += n; else out.suggested += n; };
  const write = async (q: SQL, kind: "auto" | "suggested", members: (g: number) => number = (g) => 2 * g) => {
    const r = await one<{ groups: number; items: number; members?: number }>(tx, q);
    // every item written was locked by this statement, so each claim succeeds; anything else is a bug: roll the step back
    if (r.items !== (r.members ?? members(r.groups))) throw new Error(`engine: pass ${p.no} claimed ${r.items} items for ${r.groups} groups`);
    bump(kind, r.groups);
    return r.groups;
  };
  const accepted = p.accept === "auto" ? "auto" : "suggested";
  if (p.cardinality !== "1:1") {
    await write(groupAcceptSql(c, p), accepted);
    if (p.on_ambiguous === "break") out.broken += (await one<{ items: number }>(tx, groupBreakSql(c, p))).items;
    // ponytail: a group pass with on_ambiguous suggest leaves its ambiguous items open (no subset sum, spec §10)
    return;
  }
  // a pass of equalities only splits its candidates by key: taking one key's pairs changes no other key, one statement does
  if (equalitiesOnly(p)) await write(fifoSql(c, p), accepted);
  else for (let r = 0; r < ROUNDS_MAX && (await write(acceptSql(c, p), accepted)) > 0; r++);
  if (p.on_ambiguous === "break") out.broken += (await one<{ items: number }>(tx, tieBreakSql(c, p))).items;
  else for (let r = 0; r < ROUNDS_MAX && (await write(tieSuggestSql(c, p), "suggested")) > 0; r++);
}

/** `from`..`to` checked (dates, forwards, at most RANGE_MAX_DAYS); one left out takes the other, both = `today`. */
export function runRange(from: string | undefined, to: string | undefined, today = todayIn(new Date())): { from: string; to: string } {
  const f = from ?? to ?? today, t = to ?? f;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || !/^\d{4}-\d{2}-\d{2}$/.test(t) || f > t) throw new ApiError("bad_request", "Pick a business date range that starts on or before its end.");
  if (days(f, t) > RANGE_MAX_DAYS) throw new ApiError("bad_request", `A run covers at most ${RANGE_MAX_DAYS} business dates.`);
  return { from: f, to: t };
}

const emptyCounters = (spec: ReconSpec): RunCounters => ({
  intake: { a: 0, b: 0 }, replaced: { a: 0, b: 0 }, passes: Object.fromEntries(spec.passes.map((p) => [String(p.no), { matched: 0, suggested: 0, broken: 0 }])), open: { a: 0, b: 0 },
});

/** A run row to write: `jobId` = the job that runs it (the reaper asks pg-boss about it), `baselineOf` = see schema.ts. */
export type NewRun = RunInput & { status: "queued" | "running"; id?: string; jobId?: string | null; baselineOf?: string | null };

/**
 * Writes the run row of version `versionId` (pinned with its spec hash) on `tx`; answers its id. Refused: a range
 * runRange refuses, a version not there, a version not published for a run that is not a simulation, a side whose
 * source the space can't read, a spec its check refuses.
 */
export async function createRun(tx: InTx, i: NewRun): Promise<string> {
  const { from, to } = runRange(i.from, i.to);
  const [v] = await tx.select({ status: reconConfigVersions.status, spec: reconConfigVersions.spec, specHash: reconConfigVersions.specHash }).from(reconConfigVersions)
    .where(and(eq(reconConfigVersions.spaceId, i.spaceId), eq(reconConfigVersions.configId, i.configId), eq(reconConfigVersions.id, i.versionId)));
  if (!v) throw new ApiError("not_found", "This recon version doesn't exist.");
  if (i.mode !== "simulation" && v.status !== "published") throw new ApiError("invalid_state", "Only the published version of a recon runs.");
  await load(tx, i.spaceId, ReconSpec.parse(v.spec));
  const id = i.id ?? Bun.randomUUIDv7();
  await tx.insert(reconRuns).values({
    id, spaceId: i.spaceId, configId: i.configId, configVersionId: i.versionId, mode: i.mode, dateFrom: from, dateTo: to, status: i.status,
    counters: emptyCounters(ReconSpec.parse(v.spec)), specHash: v.specHash, jobId: i.jobId ?? null, baselineOf: i.baselineOf ?? null,
  });
  return id;
}

/** The sentence of a run that failed on something other than an ApiError (the cause is in the log only). */
export const RUN_INTERNAL_ERROR = "The run stopped on an internal error. Run it again; if it fails again, tell your admin.";

type RunRow = typeof reconRuns.$inferSelect;

/** Thrown between steps once the job's signal aborted (pg-boss gave the job up): the run stays running for the retry. */
export class RunAborted extends Error {}

/**
 * Runs run `runId` of space `spaceId` on `on` (the worker's workerDb, or the API's db in tests) to its end; a run over
 * already is left as it is (null). Each business date D: the records' statistics (own transaction), then per side its
 * intake (own transaction, marker `intake_done`) and that side's new items' statistics (own transaction), then the
 * passes (marker `done_through` = D). ANALYZE holds a partition's share-update-exclusive lock, so it never runs in a
 * transaction that also does the work: other configs' steps on the same month don't wait behind ours.
 *
 * Every writing transaction takes configLock and the run row FOR UPDATE, and skips what its marker says is done, with
 * the counters read there: a job delivered twice (a retry while the first is still alive) adds nothing twice. The last
 * transaction marks the run succeeded only while it is running, then runs `finish` (a simulation's changes and its
 * draft's hash); a second delivery finds it over and returns null. `signal` aborted → RunAborted between steps. Any
 * other failure marks the run failed with the error's sentence (an ApiError's, else RUN_INTERNAL_ERROR) and throws it.
 */
export async function execRun(on: Tx, spaceId: string, runId: string, o: { finish?: (tx: InTx) => Promise<void>; signal?: AbortSignal } = {}): Promise<RunSummary | null> {
  const scope = { spaceIds: [spaceId], userId: null };
  const mine = and(eq(reconRuns.spaceId, spaceId), eq(reconRuns.id, runId));
  const [run] = await withSpace(scope, (tx) => tx.select().from(reconRuns).where(mine), on);
  if (!run) throw new ApiError("not_found", "This run doesn't exist.");
  if (run.status === "succeeded" || run.status === "failed") return null;
  const configId = run.configId;
  try {
    const { spec, sides } = await withSpace(scope, async (tx) => {
      const [v] = await tx.select({ spec: reconConfigVersions.spec, specHash: reconConfigVersions.specHash }).from(reconConfigVersions)
        .where(and(eq(reconConfigVersions.spaceId, spaceId), eq(reconConfigVersions.id, run.configVersionId)));
      if (!v) throw new ApiError("not_found", "This recon version doesn't exist.");
      if (run.specHash && v.specHash !== run.specHash) throw new ApiError("invalid_state", "The draft changed after this simulation was asked for. Run the simulation again.");
      if (run.status === "queued") await tx.update(reconRuns).set({ status: "running" }).where(and(mine, eq(reconRuns.status, "queued")));
      return load(tx, spaceId, ReconSpec.parse(v.spec));
    }, on);
    const carry = spec.carry_over_days;
    const first = addDays(run.dateFrom, -carry), to = run.dateTo;
    const months = (Number(to.slice(0, 4)) - Number(first.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(first.slice(5, 7)) + 1;
    await on.transaction((tx) => ensureMonthPartitions(tx, reconItems, new Date(`${first}T00:00:00Z`), months));
    const simRunId = run.mode === "simulation" ? runId : null;
    /** `fn` with the config's lock and the run row locked, when the run is still running; "over" when it is not. */
    const step = <T>(fn: (tx: InTx, r: RunRow, counters: RunCounters) => Promise<T>) => withSpace(scope, async (tx) => {
      await configLock(tx, configId);
      const [r] = await tx.select().from(reconRuns).where(mine).for("update");
      if (r?.status !== "running") return "over" as const;
      return fn(tx, r, (r.counters as RunCounters).passes ? (r.counters as RunCounters) : emptyCounters(spec));
    }, on);
    const analyze = (table: "records" | "recon_items", lo: string, hi: string, added: number) => on.transaction((tx) => one(tx, analyzeSql(table, lo, hi, added)));
    for (let d = run.doneThrough ? addDays(run.doneThrough, 1) : run.dateFrom; d <= to; d = addDays(d, 1)) {
      if (o.signal?.aborted) throw new RunAborted();
      const lo = addDays(d, -carry), hi = d;
      const c = (tx: InTx): StepCtx => ({ spaceId, configId, versionId: run.configVersionId, runId, simRunId, sides, lo, hi, current: currentRecord(tx)! });
      // planner statistics first (analyzeSql): records a source just took in, then each side's new items (side B's
      // intake checks side A's, and the passes read both)
      await analyze("records", lo, hi, 0);
      for (const s of [0, 1] as const) {
        const tag = `${d}:${sides[s].key}`;
        const added = await step(async (tx, r, counters) => {
          if ((r.doneThrough && r.doneThrough >= d) || (r.intakeDone && r.intakeDone >= tag)) return 0;
          counters.replaced[sides[s].key] += (await one<{ n: number }>(tx, closeReplacedSql(c(tx), s))).n;
          const n = (await one<{ n: number }>(tx, intakeSql(c(tx), s, spec.sides[s].filter))).n;
          counters.intake[sides[s].key] += n;
          await tx.update(reconRuns).set({ counters, intakeDone: tag }).where(mine);
          return n;
        });
        if (added === "over") return null;
        if (added) await analyze("recon_items", lo, hi, added);
      }
      const passed = await step(async (tx, r, counters) => {
        if (r.doneThrough && r.doneThrough >= d) return;
        for (const p of spec.passes) await runPass(tx, c(tx), p, counters.passes[String(p.no)]!);
        await tx.update(reconRuns).set({ counters, doneThrough: d }).where(mine);
      });
      if (passed === "over") return null;
    }
    const counters = await step(async (tx, _r, counters) => {
      const open = await tx.select({ side: reconItems.side, n: count() }).from(reconItems).where(and(
        eq(reconItems.spaceId, spaceId), eq(reconItems.configId, configId), eq(reconItems.status, "open"),
        simRunId ? eq(reconItems.simRunId, simRunId) : sql`${reconItems.simRunId} is null`,
        sql`${reconItems.businessDate} between ${first}::date and ${to}::date`,
      )).groupBy(reconItems.side);
      counters.open = { a: 0, b: 0 };
      for (const r of open) counters.open[r.side as "a" | "b"] = r.n;
      // succeeded first (only while running, under the row lock), then what comes with it
      await tx.update(reconRuns).set({ counters, status: "succeeded", finishedAt: sql`now()` }).where(and(mine, eq(reconRuns.status, "running")));
      await o.finish?.(tx);
      return counters;
    });
    return counters === "over" ? null : { runId, counters };
  } catch (e) {
    if (e instanceof RunAborted) throw e;
    // a person reads `error`: an ApiError's sentence, never a query's text (Drizzle's message holds the SQL and its values)
    if (!(e instanceof ApiError)) log.error({ err: errorDetail(e), runId }, "recon run failed");
    await failRun(on, spaceId, runId, e instanceof ApiError ? e.message : RUN_INTERNAL_ERROR);
    throw e;
  }
}

/** Marks run `runId` failed with `error` (a sentence for people) unless it is over already. */
export async function failRun(on: Tx, spaceId: string, runId: string, error: string): Promise<void> {
  await withSpace({ spaceIds: [spaceId], userId: null }, (tx) => tx.update(reconRuns).set({ status: "failed", error, finishedAt: sql`now()` })
    .where(and(eq(reconRuns.spaceId, spaceId), eq(reconRuns.id, runId), sql`${reconRuns.status} in ('queued', 'running')`)), on);
}

/**
 * Runs version `versionId` of config `configId` over business dates `from`..`to` on `on` now, in this process (no job):
 * createRun then execRun. `simulation` writes items of its own run and never touches live ones.
 */
export async function runRecon(on: Tx, i: RunInput): Promise<RunSummary> {
  const runId = await withSpace({ spaceIds: [i.spaceId], userId: null }, (tx) => createRun(tx, { ...i, status: "running" }), on);
  return (await execRun(on, i.spaceId, runId))!;
}

// ------------------------------------------------------------------------------------------------ reads
// GET …/recons/:configId/runs*: any role of the space reads. A run of another config, or a published version's
// simulation asked for through its draft's (baseline_of), is 404 here; the draft's run names it.

const iso = (d: Date | null) => d?.toISOString() ?? null;

/** ReconRunDto of `rows`: version numbers, baselines and change counts in three queries for the whole page. */
async function runDtos(tx: InTx, spaceId: string, rows: RunRow[]): Promise<ReconRunDto[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const baselines = await tx.select({ of: reconRuns.baselineOf, id: reconRuns.id, versionId: reconRuns.configVersionId }).from(reconRuns)
    .where(and(eq(reconRuns.spaceId, spaceId), inArray(reconRuns.baselineOf, ids)));
  const versions = new Map((await tx.select({ id: reconConfigVersions.id, version: reconConfigVersions.version }).from(reconConfigVersions)
    .where(and(eq(reconConfigVersions.spaceId, spaceId), inArray(reconConfigVersions.id, [...rows.map((r) => r.configVersionId), ...baselines.map((b) => b.versionId)])))).map((v) => [v.id, v.version]));
  const changed = await tx.select({ runId: reconSimChanges.runId, change: reconSimChanges.change, n: count() }).from(reconSimChanges)
    .where(and(eq(reconSimChanges.spaceId, spaceId), inArray(reconSimChanges.runId, ids))).groupBy(reconSimChanges.runId, reconSimChanges.change);
  return rows.map((r): ReconRunDto => {
    const b = baselines.find((x) => x.of === r.id);
    const isDraftSim = r.mode === "simulation" && !r.baselineOf;
    const n = (c: SimChange) => changed.find((x) => x.runId === r.id && x.change === c)?.n ?? 0;
    return {
      id: r.id, configId: r.configId, versionId: r.configVersionId, version: versions.get(r.configVersionId) ?? 0, specHash: r.specHash, mode: r.mode as RunMode, status: r.status as RunStatus,
      from: r.dateFrom, to: r.dateTo, doneThrough: r.doneThrough, counters: r.counters as RunCounters, error: r.error,
      startedAt: r.startedAt.toISOString(), finishedAt: iso(r.finishedAt),
      baseline: b ? { runId: b.id, versionId: b.versionId, version: versions.get(b.versionId) ?? 0 } : null,
      changes: isDraftSim && r.status === "succeeded" ? { gained: n("gained"), lost: n("lost"), repaired: n("repaired"), kind: n("kind") } : null,
    };
  });
}

const configExists = async (tx: InTx, spaceId: string, configId: string) => {
  const [c] = await tx.select({ id: reconConfigs.id }).from(reconConfigs).where(and(eq(reconConfigs.spaceId, spaceId), eq(reconConfigs.id, configId)));
  if (!c) throw notFound("recon");
};
/** Run `runId` of config `configId` (not a published version's simulation behind a draft's); 404 otherwise. */
async function runOfConfig(tx: InTx, spaceId: string, configId: string, runId: string): Promise<RunRow> {
  await configExists(tx, spaceId, configId);
  const [r] = await tx.select().from(reconRuns).where(and(eq(reconRuns.spaceId, spaceId), eq(reconRuns.configId, configId), eq(reconRuns.id, runId), isNull(reconRuns.baselineOf)));
  if (!r) throw notFound("run");
  return r;
}

/** The run as answered (also the answer of a run or simulation request). */
export async function runRow(tx: InTx, spaceId: string, configId: string, runId: string): Promise<ReconRunDto> {
  return (await runDtos(tx, spaceId, [await runOfConfig(tx, spaceId, configId, runId)]))[0]!;
}

/**
 * Version `versionId`'s spec and the spaces its sides' records live in (its own, and a sharing source's), so a records
 * join uses their primary key (space_id, id, business_date).
 */
async function versionRead(tx: InTx, spaceId: string, versionId: string): Promise<{ spec: ReconSpec; recordSpaces: string[] }> {
  const [v] = await tx.select({ spec: reconConfigVersions.spec }).from(reconConfigVersions)
    .where(and(eq(reconConfigVersions.spaceId, spaceId), eq(reconConfigVersions.id, versionId)));
  const spec = ReconSpec.parse(v!.spec);
  const found = await readableSources(tx, spaceId, spec.sides.map((s) => s.source_id));
  return { spec, recordSpaces: [...new Set([spaceId, ...[...found.values()].map((s) => s.spaceId)])] };
}

const inSpace = <T>(ctx: Ctx, fn: (tx: InTx, spaceId: string) => Promise<T>) =>
  withSpace({ spaceIds: [ctx.space!.id], userId: ctx.user.id }, (tx) => fn(tx, ctx.space!.id));

/** GET …/runs/:runId. */
export const runDetail = (ctx: Ctx, configId: string, runId: string) => inSpace(ctx, (tx, spaceId) => runRow(tx, spaceId, configId, runId));

/** GET …/runs: the config's runs and draft simulations, newest first unless `sort` says otherwise. */
export function runPage(ctx: Ctx, configId: string, q: ReconRunListQuery): Promise<Page<ReconRunDto>> {
  return inSpace(ctx, async (tx, spaceId) => {
    await configExists(tx, spaceId, configId);
    const where = and(eq(reconRuns.spaceId, spaceId), eq(reconRuns.configId, configId), isNull(reconRuns.baselineOf),
      q.mode ? eq(reconRuns.mode, q.mode) : undefined, q.versionId ? eq(reconRuns.configVersionId, q.versionId) : undefined);
    const page = await pageQuery({
      rows: tx.select().from(reconRuns).where(where).$dynamic(),
      count: tx.select(countOne).from(reconRuns).where(where).$dynamic(),
      orderBy: sortSql(q.sort, { startedAt: reconRuns.startedAt }, "-startedAt", reconRuns.id),
      query: q, map: (r) => r, on: tx,
    });
    return { ...page, items: await runDtos(tx, spaceId, page.items) };
  });
}

/**
 * GET …/runs/:runId/items: the items the run worked on: its own (a simulation) or the live ones (another run), of its
 * business dates and the carry over before them, as they are now, with their record and current group. `pass` = items
 * in a group of that pass.
 */
export function runItemPage(ctx: Ctx, configId: string, runId: string, q: ReconRunItemQuery): Promise<Page<ReconRunItemDto>> {
  return inSpace(ctx, async (tx, spaceId) => {
    const run = await runOfConfig(tx, spaceId, configId, runId);
    const { spec, recordSpaces } = await versionRead(tx, spaceId, run.configVersionId);
    const where = and(
      eq(reconItems.spaceId, spaceId), eq(reconItems.configId, configId),
      run.mode === "simulation" ? eq(reconItems.simRunId, run.id) : isNull(reconItems.simRunId),
      sql`${reconItems.businessDate} between ${addDays(run.dateFrom, -spec.carry_over_days)}::date and ${run.dateTo}::date`,
      q.status ? eq(reconItems.status, q.status) : undefined, q.side ? eq(reconItems.side, q.side) : undefined,
      q.pass ? eq(matchGroups.passNo, q.pass) : undefined,
    );
    // the item's group now: a group it is a member of that was not reversed
    const group = and(eq(matchGroups.spaceId, reconItems.spaceId), isNull(matchGroups.reversedBy), inArray(matchGroups.id,
      tx.select({ id: matchMembers.groupId }).from(matchMembers).where(and(eq(matchMembers.spaceId, reconItems.spaceId), eq(matchMembers.itemId, reconItems.id)))));
    const record = and(inArray(records.spaceId, recordSpaces), eq(records.id, reconItems.recordId), eq(records.businessDate, reconItems.businessDate));
    return pageQuery({
      rows: tx.select({ i: reconItems, g: matchGroups, ref: records.extRef, amount: records.amountMinor, ccy: records.currency })
        .from(reconItems).leftJoin(matchGroups, group).leftJoin(records, record).where(where).$dynamic(),
      count: tx.select(countOne).from(reconItems).leftJoin(matchGroups, group).where(where).$dynamic(),
      orderBy: sortSql(q.sort, { businessDate: reconItems.businessDate }, "businessDate", reconItems.id),
      query: q, on: tx,
      map: ({ i, g, ref, amount, ccy }): ReconRunItemDto => ({
        id: i.id, recordId: i.recordId, side: i.side as "a" | "b", status: i.status as ItemStatus, businessDate: i.businessDate, breakReason: i.breakReason,
        extRef: ref, amountMinor: amount?.toString() ?? null, currency: ccy,
        group: g ? { id: g.id, passNo: g.passNo, kind: g.kind as GroupKind, businessDate: g.businessDate, evidence: g.evidence } : null,
      }),
    });
  });
}

/** GET …/runs/:runId/changes: a draft simulation's changed pairs (empty for another run), by business date. */
export function simChangePage(ctx: Ctx, configId: string, runId: string, q: ReconSimChangeQuery): Promise<Page<ReconSimChangeDto>> {
  return inSpace(ctx, async (tx, spaceId) => {
    const run = await runOfConfig(tx, spaceId, configId, runId);
    const where = and(eq(reconSimChanges.spaceId, spaceId), eq(reconSimChanges.runId, runId), q.change ? eq(reconSimChanges.change, q.change) : undefined);
    const page = await pageQuery({
      rows: tx.select().from(reconSimChanges).where(where).$dynamic(),
      count: tx.select(countOne).from(reconSimChanges).where(where).$dynamic(),
      orderBy: [asc(reconSimChanges.businessDate), asc(reconSimChanges.id)],
      query: q, map: (r) => r, on: tx,
    });
    const ids = page.items.flatMap((r) => [r.draftGroupId, r.publishedGroupId]).filter((x): x is string => !!x);
    // the published version's sides may read other sources than the draft's: both versions' record spaces
    const baseline = page.items.length ? (await tx.select({ v: reconRuns.configVersionId }).from(reconRuns).where(and(eq(reconRuns.spaceId, spaceId), eq(reconRuns.baselineOf, run.id))))[0] : undefined;
    const recordSpaces = [...new Set([
      ...(await versionRead(tx, spaceId, run.configVersionId)).recordSpaces, ...(baseline ? (await versionRead(tx, spaceId, baseline.v)).recordSpaces : []),
    ])];
    const rows = ids.length ? await tx.select({ g: matchGroups, side: matchMembers.side, recordId: reconItems.recordId, ref: records.extRef, amount: records.amountMinor })
      .from(matchGroups).innerJoin(matchMembers, and(eq(matchMembers.spaceId, matchGroups.spaceId), eq(matchMembers.groupId, matchGroups.id)))
      .innerJoin(reconItems, and(eq(reconItems.spaceId, matchMembers.spaceId), eq(reconItems.id, matchMembers.itemId)))
      .leftJoin(records, and(inArray(records.spaceId, recordSpaces), eq(records.id, reconItems.recordId), eq(records.businessDate, reconItems.businessDate)))
      .where(and(eq(matchGroups.spaceId, spaceId), inArray(matchGroups.id, ids))).orderBy(asc(matchMembers.side), asc(reconItems.recordId)) : [];
    const groupOf = (id: string | null) => {
      const ms = rows.filter((r) => r.g.id === id);
      if (!id || !ms.length) return null;
      return { id, passNo: ms[0]!.g.passNo, kind: ms[0]!.g.kind as GroupKind, members: ms.map((m) => ({ side: m.side as "a" | "b", recordId: m.recordId, extRef: m.ref, amountMinor: m.amount?.toString() ?? null })) };
    };
    return {
      ...page,
      items: page.items.map((r): ReconSimChangeDto => ({
        id: r.id, change: r.change as SimChange, businessDate: r.businessDate, draft: groupOf(r.draftGroupId), published: groupOf(r.publishedGroupId),
      })),
    };
  });
}
