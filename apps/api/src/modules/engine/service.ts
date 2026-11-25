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
import { CARRY_ALWAYS_MIN_DAYS, isOneWay, recordFields } from "@starterkit/shared/recon";
import type { Page } from "@starterkit/shared/contracts/common";
import type { ReconRunDto, ReconRunItemDto, RunDay, RunGroupMember, RunProjection, ReconRunItemQuery, ReconRunListQuery, ReconSimChangeDto, ReconSimChangeQuery } from "@starterkit/shared/contracts/recon";
import { GROUP_MEMBERS_MAX, type GroupKind, type ItemStatus, RUN_RANGE_MAX_DAYS, type RunMode, type RunStatus, type SimChange } from "@starterkit/shared/recon";
import { and, asc, count, countDistinct, eq, exists, inArray, isNotNull, isNull, lte, ne, or, sql, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { InTx, Tx } from "../../kernel/db";
import { ApiError, errorDetail, notFound } from "../../kernel/errors";
import { log } from "../../kernel/log";
import { enqueue, QUEUE_OPTIONS, type QueueName, QUEUES } from "../../kernel/jobs";
import { configLock } from "../../kernel/locks";
import { one as countOne, pageQuery, sortSql } from "../../kernel/pagination";
import { ensureMonthPartitions } from "../../kernel/partitions";
import type { Ctx } from "../auth";
import { currentRecord, records, sourceCursors, todayIn } from "../ingest";
import { checkReconSpec, reconConfigs, reconConfigVersions } from "../recon";
import { readableSources } from "../sources";
import { withSpace } from "../spaces";
import { matchGroups, matchMembers, reconDays, reconIntakeMarks, reconItems, reconRuns, reconSimChanges } from "./schema";
import { groupBreakSql, nearMissSql, type NearMissReason, tieBreakSql } from "./sql/breaks";
import { closeReplacedSql, intakeSql, reverseReplacedSql } from "./sql/intake";
import { graceSql } from "./sql/days";
import { analyzeSql, analyzeTableSql, runHasRecordsSql } from "./sql/runs";
import { queueDay } from "./stats";
import { acceptSql, clearProposalsSql, type Dated, equalitiesOnly, fifoSql, groupAcceptSql, proposeSql, ruleSql, type SideRef, type StepCtx, tieSuggestSql } from "./sql/pass";

export type { RunMode };
/** What a pass did over the run: groups it accepted, groups it suggested, items it broke as ambiguous. */
type PerSide = { a: number; b: number };
/**
 * What a pass did over a run: groups matched and suggested, items broken and their distinct references, and the items
 * of each per side (a group pass pairs one item with n, so groups don't split evenly).
 */
export type PassCounters = {
  matched: number; suggested: number; broken: number; brokenRefs: number; matchedItems: PerSide; suggestedItems: PerSide; brokenItems: PerSide;
};
/**
 * A run's counters: items taken in per side, items closed because their record was replaced, per pass (by number), and
 * items still open per side in the window after.
 */
export type RunCounters = {
  intake: { a: number; b: number }; replaced: { a: number; b: number }; passes: Record<string, PassCounters>; open: { a: number; b: number };
  /** The carry over this run resolved (always = from the oldest unmatch): its windows read it back, so they don't move later. */
  carry?: number;
};
export type RunInput = {
  spaceId: string; configId: string; versionId: string; mode: RunMode;
  /** Business dates (yyyy-mm-dd), at most RANGE_MAX_DAYS; both default to today in Asia/Jakarta. */
  from?: string; to?: string;
};
export type RunSummary = { runId: string; counters: RunCounters };
/** recon_runs.seen: per business date and side, the source's complete_through the run's intake of that date saw. */
export type Seen = Record<string, Partial<Record<"a" | "b", string | null>>>;

/** The longest range one run covers (Plan 3 Task 3: a day by default, 31 at most). */
export const RANGE_MAX_DAYS = RUN_RANGE_MAX_DAYS;
/**
 * Rounds of a pass's choice in one step. ponytail: each round takes at least one pair, so a key doubled k times on both
 * sides needs k tie rounds; past this the rest waits for the next run. Raise it, or pair ties by ROW_NUMBER in one
 * statement, if real duplicates run deeper.
 */
const ROUNDS_MAX = 50;
/**
 * Records a side's intake takes in one transaction (Task 6 "run harian per chunk"). ponytail: only the intake is per
 * chunk; the passes of a date stay one transaction (S1: 376 s for 3M a side on the worker pool); split them per key
 * range if a date outgrows JOB_STATEMENT_TIMEOUT_MS.
 */
export const INTAKE_CHUNK = 50_000;

/** The queue a run of `mode` goes to (spec §9 table): ticks and daily runs have their own (Task 6); the rest is heavy. */
export const queueOf = (mode: string): QueueName => (mode === "tick" ? QUEUES.reconTick : mode === "daily" ? QUEUES.reconDaily : QUEUES.reconHeavy);
/**
 * The statement timeout of a date's passes (DEC-036: per queue): its queue's job expiry, past which pg-boss gives the
 * job up anyway, instead of the pool's JOB_STATEMENT_TIMEOUT_MS. A pass's statement grows with its writes (3M items a
 * side, one claim statement: 174 s on the reference laptop, docs/recon/spikes.md "REC-P1"), not with a bad plan.
 * ponytail: one statement per pass and date; bucket the pass by key hash over a temp pool if a date outgrows its job.
 */
const passTimeoutMs = (mode: string) => QUEUE_OPTIONS[queueOf(mode)].expireInSeconds! * 1000;

const DAY = 86_400_000;
export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

/**
 * The carry over a window uses (owner, 22 Nov: match / unmatch): the spec's days as they are, or with `null` (always)
 * the days from the recon's oldest unmatch still checked — open, or a "No counterpart" break with late_match — to
 * `from`, at least 1 (so day close keeps late_match on) and at most 3660. The run then reads from that date: only items
 * still unmatched, never the whole history of records (intake is per record, once). A not_required item (one-way,
 * DEC-055) never widens it: side B of a one-way recon never settles by itself, so the window would grow without bound;
 * it stays a candidate within the window side A's unmatch keeps (at least 31 days).
 */
export async function effectiveCarry(tx: InTx, k: { spaceId: string; configId: string; simRunId?: string | null }, carry: number | null, from: string): Promise<number> {
  if (carry !== null) return carry;
  // the live unmatch (a simulation starts with none of its own: it reads the live recon's, blind review I2)
  const [r] = await tx.select({ d: sql<string | null>`min(${reconItems.businessDate})::text` }).from(reconItems)
    .where(and(eq(reconItems.spaceId, k.spaceId), eq(reconItems.configId, k.configId), isNull(reconItems.simRunId),
      or(eq(reconItems.status, "open"), and(eq(reconItems.status, "break"), eq(reconItems.lateMatch, true), eq(reconItems.breakReason, "No counterpart")))));
  const days = r?.d ? Math.round((Date.parse(`${from}T00:00:00Z`) - Date.parse(`${r.d}T00:00:00Z`)) / DAY) : 0;
  // at least 31 (as far back as day + N goes): late data dated before the oldest unmatch still comes in (blind review I1)
  return Math.min(3660, Math.max(CARRY_ALWAYS_MIN_DAYS, days));
}
const days = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY) + 1;

type Loaded = { spec: ReconSpec; sides: [SideRef, SideRef] };

/**
 * The sides of `spec` as space `spaceId` reads their sources; refused when a side's source is not readable here or the
 * spec's check fails (every field on the sides' whitelists).
 */
export async function load(tx: InTx, spaceId: string, spec: ReconSpec): Promise<Loaded> {
  const found = await readableSources(tx, spaceId, spec.sides.map((s) => s.source_id));
  const sides = spec.sides.map((s) => {
    const src = found.get(s.source_id);
    if (!src?.spec) throw new ApiError("bad_request", `Side ${s.key.toUpperCase()}: this space can't read a published version of its source.`);
    return { key: s.key, sourceSpaceId: src.spaceId, sourceId: s.source_id, fields: recordFields(src.spec), negate: s.amount_sign === "negate", snapshot: src.spec.input.kind === "db_snapshot", spec: src.spec };
  });
  const check = checkReconSpec(spec, [{ spec: sides[0]!.spec, currencies: [] }, { spec: sides[1]!.spec, currencies: [] }]);
  if (check.errors.length) throw new ApiError("bad_request", check.errors[0]!);
  const [a, b] = sides.map(({ spec: _, ...s }): SideRef => s);
  return { spec, sides: [a!, b!] };
}

/** Runs `q` (a compiled statement answering one row) on `tx`. */
const one = async <T>(tx: InTx, q: SQL) => ((await tx.execute(q)) as unknown as T[])[0]!;

/**
 * One pass over the step's window: its choice repeated while it pairs, then its ties per on_ambiguous. A rule (1:0)
 * matches its side's items that meet it in one statement: one item per group, no ties.
 */
async function runPass(tx: InTx, c: StepCtx, p: ReconSpec["passes"][number], out: PassCounters, touch: (r: Dated) => void): Promise<void> {
  const add = (x: PerSide, a: number, b: number) => { x.a += a; x.b += b; };
  // the side of single items of a group pass (pass.ts groupsSql): N:1 B, 1:N A; a 1:1 group has one of each; a rule's own side
  const oneSide = p.cardinality === "N:1" ? "b" : p.cardinality === "1:0" ? (p.side ?? "a") : "a";
  const write = async (q: SQL, kind: "auto" | "suggested", members: (g: number) => number = (g) => 2 * g) => {
    const r = await one<{ groups: number; items: number; members?: number } & Dated>(tx, q);
    touch(r);
    // every item written was locked by this statement, so each claim succeeds; anything else is a bug: roll the step back
    if (r.items !== (r.members ?? members(r.groups))) throw new Error(`engine: pass ${p.no} claimed ${r.items} items for ${r.groups} groups`);
    if (kind === "auto") out.matched += r.groups; else out.suggested += r.groups;
    const many = r.items - r.groups;
    add(kind === "auto" ? out.matchedItems : out.suggestedItems, oneSide === "a" ? r.groups : many, oneSide === "a" ? many : r.groups);
    return r.groups;
  };
  // ponytail: refs are counted per step, so a key broken again on a later date of the same run counts twice
  const broke = (r: { items: number; refs: number; a: number } & Dated) => { touch(r); out.broken += r.items; out.brokenRefs += r.refs; add(out.brokenItems, r.a, r.items - r.a); };
  const accepted = p.accept === "auto" ? "auto" : "suggested";
  if (p.cardinality === "1:0") {
    await write(ruleSql(c, p), "auto", (g) => g);
    return;
  }
  if (p.cardinality !== "1:1") {
    await write(groupAcceptSql(c, p), accepted);
    if (p.on_ambiguous === "break") broke(await one<{ items: number; refs: number; a: number } & Dated>(tx, groupBreakSql(c, p)));
    // ponytail: a group pass with on_ambiguous suggest leaves its ambiguous items open (no subset sum, spec §10)
    return;
  }
  // a pass of equalities only splits its candidates by key: taking one key's pairs changes no other key, one statement does
  if (equalitiesOnly(p)) await write(fifoSql(c, p), accepted);
  else for (let r = 0; r < ROUNDS_MAX && (await write(acceptSql(c, p), accepted)) > 0; r++);
  if (p.on_ambiguous === "break") broke(await one<{ items: number; refs: number; a: number } & Dated>(tx, tieBreakSql(c, p)));
  else for (let r = 0; r < ROUNDS_MAX && (await write(tieSuggestSql(c, p), "suggested")) > 0; r++);
  // a break of the carry-over window this pass would suggest a pair for stays a break, with the pair proposed (DEC-047)
  if (c.late && (p.accept === "suggest" || p.on_ambiguous === "suggest")) touch(await one<Dated>(tx, proposeSql(c, p)));
}

/** `from`..`to` checked (dates, forwards, at most RANGE_MAX_DAYS); one left out takes the other, both = `today`. */
export function runRange(from: string | undefined, to: string | undefined, today = todayIn(new Date())): { from: string; to: string } {
  const f = from ?? to ?? today, t = to ?? f;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f) || !/^\d{4}-\d{2}-\d{2}$/.test(t) || f > t) throw new ApiError("bad_request", "Pick a business date range that starts on or before its end.");
  if (days(f, t) > RANGE_MAX_DAYS) throw new ApiError("bad_request", `A run covers at most ${RANGE_MAX_DAYS} business dates.`);
  return { from: f, to: t };
}

const zeroPass = (): PassCounters => ({
  matched: 0, suggested: 0, broken: 0, brokenRefs: 0, matchedItems: { a: 0, b: 0 }, suggestedItems: { a: 0, b: 0 }, brokenItems: { a: 0, b: 0 },
});
const emptyCounters = (spec: ReconSpec): RunCounters => ({
  intake: { a: 0, b: 0 }, replaced: { a: 0, b: 0 }, passes: Object.fromEntries(spec.passes.map((p) => [String(p.no), zeroPass()])), open: { a: 0, b: 0 },
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
  const [v] = await tx.select({ status: reconConfigVersions.status, spec: reconConfigVersions.spec, matchingHash: reconConfigVersions.matchingHash }).from(reconConfigVersions)
    .where(and(eq(reconConfigVersions.spaceId, i.spaceId), eq(reconConfigVersions.configId, i.configId), eq(reconConfigVersions.id, i.versionId)));
  if (!v) throw new ApiError("not_found", "This recon version doesn't exist.");
  if (i.mode !== "simulation" && v.status !== "published") throw new ApiError("invalid_state", "Only the published version of a recon runs.");
  await load(tx, i.spaceId, ReconSpec.parse(v.spec));
  const id = i.id ?? Bun.randomUUIDv7();
  await tx.insert(reconRuns).values({
    id, spaceId: i.spaceId, configId: i.configId, configVersionId: i.versionId, mode: i.mode, dateFrom: from, dateTo: to, status: i.status,
    counters: emptyCounters(ReconSpec.parse(v.spec)), specHash: v.matchingHash, jobId: i.jobId ?? null, baselineOf: i.baselineOf ?? null,
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
export async function execRun(on: Tx, spaceId: string, runId: string, o: { finish?: (tx: InTx) => Promise<void>; signal?: AbortSignal; chunk?: number } = {}): Promise<RunSummary | null> {
  const chunk = o.chunk ?? INTAKE_CHUNK;
  const scope = { spaceIds: [spaceId], userId: null };
  const mine = and(eq(reconRuns.spaceId, spaceId), eq(reconRuns.id, runId));
  const [run] = await withSpace(scope, (tx) => tx.select().from(reconRuns).where(mine), on);
  if (!run) throw new ApiError("not_found", "This run doesn't exist.");
  if (run.status === "succeeded" || run.status === "failed") return null;
  const configId = run.configId;
  try {
    const { spec, sides } = await withSpace(scope, async (tx) => {
      // a run's spec_hash is the version's matching hash (no approval setup): an approval-only edit doesn't stale it
      const [v] = await tx.select({ spec: reconConfigVersions.spec, matchingHash: reconConfigVersions.matchingHash }).from(reconConfigVersions)
        .where(and(eq(reconConfigVersions.spaceId, spaceId), eq(reconConfigVersions.id, run.configVersionId)));
      if (!v) throw new ApiError("not_found", "This recon version doesn't exist.");
      if (run.specHash && v.matchingHash !== run.specHash) throw new ApiError("invalid_state", "The draft changed after this simulation was asked for. Run the simulation again.");
      if (run.status === "queued") await tx.update(reconRuns).set({ status: "running" }).where(and(mine, eq(reconRuns.status, "queued")));
      return load(tx, spaceId, ReconSpec.parse(v.spec));
    }, on);
    // resolved once per run against its last date (so every date of a catch-up keeps the oldest unmatch in its window),
    // kept in the run's counters for always (a number of days never moves): what a run read stays what it read (blind review I2, I3)
    const kept = (run.counters as RunCounters | null)?.carry;
    const carry = kept ?? await withSpace(scope, (tx) => effectiveCarry(tx, { spaceId, configId }, spec.carry_over_days, run.dateTo), on);
    if (kept === undefined && spec.carry_over_days === null) await withSpace(scope, (tx) => tx.update(reconRuns).set({ counters: sql`coalesce(${reconRuns.counters}, '{}'::jsonb) || jsonb_build_object('carry', ${carry}::int)` }).where(mine), on);
    const first = addDays(run.dateFrom, -carry), to = run.dateTo;
    const months = (Number(to.slice(0, 4)) - Number(first.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(first.slice(5, 7)) + 1;
    await on.transaction((tx) => ensureMonthPartitions(tx, reconItems, new Date(`${first}T00:00:00Z`), months));
    const simRunId = run.mode === "simulation" ? runId : null;
    /**
     * `fn` with the config's lock and the run row locked, when the run is still running; "over" when it is not. The
     * business dates its statements changed (`touch`, a statement's Dated answer) get their dashboard rollup queued in
     * the same transaction (a live run only), the carry-over dates before the run's own too (C1).
     */
    const step = <T>(fn: (tx: InTx, r: RunRow, counters: RunCounters, touch: (r: Dated) => void) => Promise<T>) => withSpace(scope, async (tx) => {
      await configLock(tx, configId);
      const [r] = await tx.select().from(reconRuns).where(mine).for("update");
      if (r?.status !== "running") return "over" as const;
      const had = r.counters as RunCounters;
      const counters = had.passes ? { ...had, passes: Object.fromEntries(Object.entries(had.passes).map(([k, v]) => [k, { ...zeroPass(), ...v }])) } : { ...emptyCounters(spec), ...(spec.carry_over_days === null ? { carry } : {}) };
      const touched = new Set<string>();
      const out = await fn(tx, r, counters, (x) => { for (const d of x.dates?.split(",") ?? []) touched.add(d); });
      if (!simRunId) for (const d of touched) await queueDay(spaceId, configId, d, tx);
      return out;
    }, on);
    const analyze = (table: "records" | "recon_items", lo: string, hi: string, added: number) => on.transaction((tx) => one<{ n: number }>(tx, analyzeSql(table, lo, hi, added)));
    for (let d = run.doneThrough ? addDays(run.doneThrough, 1) : run.dateFrom; d <= to; d = addDays(d, 1)) {
      if (o.signal?.aborted) throw new RunAborted();
      const lo = addDays(d, -carry), hi = d;
      const c = (tx: InTx): StepCtx => ({ spaceId, configId, versionId: run.configVersionId, runId, simRunId, sides, lo, hi, current: currentRecord(tx)!, late: carry > 0, oneWay: isOneWay(spec) });
      // planner statistics first (analyzeSql): records a source just took in, then each side's new items (side B's
      // intake checks side A's, and the passes read both)
      await analyze("records", lo, hi, 0);
      for (const s of [0, 1] as const) {
        const side = sides[s], tag = `${d}:${side.key}`;
        // a live intake of a source that isn't a snapshot reads past its mark per date (reconIntakeMarks, REC-P1); a
        // simulation or a snapshot source reads each date from the start, in seq order all the same
        const marked = !simRunId && !side.snapshot;
        const mark = and(eq(reconIntakeMarks.spaceId, spaceId), eq(reconIntakeMarks.configVersionId, run.configVersionId), eq(reconIntakeMarks.side, side.key));
        // per chunk of `chunk` records of the window (its dates in order), a transaction each (a daily run's millions never sit in one
        // statement), keyset on seq so no chunk reads what one before it read; a chunk committed before a retry is
        // skipped by the intake's own check, the marker comes with the last chunk of the window's last date.
        // Fresh statistics between chunks too: planned over a partition analyzed while it held none of this config's
        // items, a chunk's anti join scanned every item for each record (200,000 a side: 72 s)
        let pending = 0, first = true, x = lo, after: number | null = null;
        let ct: string | null = null;
        for (;;) {
          const got = await step(async (tx, r, counters, touch) => {
            if ((r.doneThrough && r.doneThrough >= d) || (r.intakeDone && r.intakeDone >= tag)) return null;
            if (first) {
              // the source's complete_through before the intake reads (read committed: every chunk sees at least
              // that much); kept with the last chunk: day close judges on it (seen)
              const [cur] = await tx.select({ ct: sourceCursors.completeThrough }).from(sourceCursors)
                .where(and(eq(sourceCursors.spaceId, side.sourceSpaceId), eq(sourceCursors.sourceId, side.sourceId)));
              ct = cur?.ct?.toISOString() ?? null;
              // a group holding a replaced record is reversed first (REC-FUT-15), so its replaced member closes below
              touch(await one<Dated>(tx, reverseReplacedSql(c(tx), s)));
              const closed = await one<{ n: number } & Dated>(tx, closeReplacedSql(c(tx), s));
              touch(closed);
              counters.replaced[side.key] += closed.n;
            }
            // the window's dates in order, as many records as one chunk holds
            let budget = chunk, n = 0;
            while (x <= hi && budget > 0) {
              const from = after ?? (marked ? (await tx.select({ seq: reconIntakeMarks.seq }).from(reconIntakeMarks).where(and(mark, eq(reconIntakeMarks.businessDate, x))))[0]?.seq ?? 0 : 0);
              const q = await one<{ n: number; scanned: number; last: string | null }>(tx, intakeSql(c(tx), s, spec.sides[s].filter, x, from, budget));
              const last = q.last === null ? from : Number(q.last);
              if (marked && last > from) {
                await tx.insert(reconIntakeMarks).values({ spaceId, configVersionId: run.configVersionId, side: side.key, businessDate: x, seq: last })
                  .onConflictDoUpdate({ target: [reconIntakeMarks.spaceId, reconIntakeMarks.configVersionId, reconIntakeMarks.side, reconIntakeMarks.businessDate], set: { seq: sql`greatest(${reconIntakeMarks.seq}, excluded.seq)` } });
              }
              if (q.n) touch({ dates: x });
              n += q.n;
              if (q.scanned < budget) { x = addDays(x, 1); after = null; } else after = last;
              budget -= q.scanned;
            }
            counters.intake[side.key] += n;
            const sideDone = x > hi;
            const seen = (r.seen ?? {}) as Seen;
            await tx.update(reconRuns).set({ counters, ...(sideDone ? { intakeDone: tag, seen: { ...seen, [d]: { ...seen[d], [side.key]: ct } } } : {}) }).where(mine);
            return { n, sideDone };
          });
          if (got === "over") return null;
          if (got === null) break;
          first = false;
          pending += got.n;
          if (pending && (await analyze("recon_items", lo, hi, pending)).n > 0) pending = 0;
          if (got.sideDone) break;
        }
      }
      const passed = await step(async (tx, r, counters, touch) => {
        if (r.doneThrough && r.doneThrough >= d) return;
        await tx.execute(sql`select set_config('statement_timeout', ${String(passTimeoutMs(r.mode))}, true)`);
        for (const p of spec.passes) await runPass(tx, c(tx), p, counters.passes[String(p.no)]!, touch);
        // a proposal whose proposed item a pass has paired since (this step's included) is cleared (DEC-047)
        if (carry > 0) touch(await one<Dated>(tx, clearProposalsSql(c(tx))));
        // grace (spec §9 step 4): live runs only; a simulation replays dates, its breaks come from the classifier
        if (!simRunId) touch(await one<Dated>(tx, graceSql(c(tx), spec.grace_minutes, carry)));
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
    if (counters === "over") return null;
    // after the run, each in a short transaction of its own; a failure there is logged and never fails the run
    const after = async (what: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
      } catch (e) {
        log.warn({ err: errorDetail(e), runId }, `recon run: ${what} failed`);
      }
    };
    // the result screens read the groups right after: their statistics first
    const groups = Object.values(counters.passes).reduce((n, p) => n + p.matched + p.suggested, 0);
    const members = Object.values(counters.passes).reduce((n, p) => n + p.matchedItems.a + p.matchedItems.b + p.suggestedItems.a + p.suggestedItems.b, 0);
    await after("statistics of match_groups", () => withSpace(scope, (tx) => one(tx, analyzeTableSql("match_groups", groups)), on));
    await after("statistics of match_members", () => withSpace(scope, (tx) => one(tx, analyzeTableSql("match_members", members)), on));
    // its days and references counted once (left not finalized on a failure: the next GET queues finalizeRun)
    await after("finalize", () => finalizeRun(on, spaceId, runId));
    const [done] = await withSpace(scope, (tx) => tx.select({ counters: reconRuns.counters }).from(reconRuns).where(mine), on);
    return { runId, counters: withoutProjection(done?.counters ?? counters) };
  } catch (e) {
    if (e instanceof RunAborted) throw e;
    // a person reads `error`: an ApiError's sentence, never a query's text (Drizzle's message holds the SQL and its values)
    if (!(e instanceof ApiError)) log.error({ err: errorDetail(e), runId }, "recon run failed");
    await failRun(on, spaceId, runId, e instanceof ApiError ? e.message : RUN_INTERNAL_ERROR);
    throw e;
  }
}

/**
 * A draft simulation's projection of day close (Captain), writing nothing: its open items through classifyUnmatched
 * (the near-miss classifier day close uses) per side, reason and date, and apart from them its unconfirmed suggestions
 * (items of suggested groups, which day close breaks too, DEC-046) per side and group date, over the run's window: its
 * dates and the carry over before them (the classifier then looks for counterparts carry over further back, as a day
 * close of `from` would). The simulation's job stores it with the run (counters.projection), so reads stay cheap.
 */
export async function projectDayClose(tx: InTx, run: RunRow): Promise<RunProjection> {
  const [v] = await tx.select({ spec: reconConfigVersions.spec }).from(reconConfigVersions)
    .where(and(eq(reconConfigVersions.spaceId, run.spaceId), eq(reconConfigVersions.id, run.configVersionId)));
  const from = addDays(run.dateFrom, -((run.counters as RunCounters | null)?.carry ?? await effectiveCarry(tx, { spaceId: run.spaceId, configId: run.configId }, ReconSpec.parse(v!.spec).carry_over_days, run.dateTo)));
  const misses = await classifyUnmatched(tx, { spaceId: run.spaceId, configId: run.configId, versionId: run.configVersionId, simRunId: run.id, from, to: run.dateTo });
  const suggested = await tx.select({ side: reconItems.side, d: matchGroups.businessDate, n: count() }).from(reconItems)
    .innerJoin(matchMembers, and(eq(matchMembers.spaceId, reconItems.spaceId), eq(matchMembers.itemId, reconItems.id)))
    .innerJoin(matchGroups, and(eq(matchGroups.spaceId, matchMembers.spaceId), eq(matchGroups.id, matchMembers.groupId), eq(matchGroups.kind, "suggested"), isNull(matchGroups.reversedBy)))
    .where(and(eq(reconItems.spaceId, run.spaceId), eq(reconItems.configId, run.configId), eq(reconItems.simRunId, run.id), eq(reconItems.status, "suggested"),
      sql`${matchGroups.businessDate} between ${from}::date and ${run.dateTo}::date`))
    .groupBy(reconItems.side, matchGroups.businessDate);
  const out: RunProjection = { a: {}, b: {}, unconfirmed: { a: 0, b: 0 }, days: [] };
  const dayOf = (date: string) => {
    let day = out.days.find((d) => d.date === date);
    if (!day) out.days.push((day = { date, a: {}, b: {}, unconfirmed: { a: 0, b: 0 } }));
    return day;
  };
  for (const m of misses) {
    out[m.side][m.reason] = (out[m.side][m.reason] ?? 0) + 1;
    const day = dayOf(m.businessDate)[m.side];
    day[m.reason] = (day[m.reason] ?? 0) + 1;
  }
  for (const r of suggested) {
    const side = r.side as "a" | "b";
    out.unconfirmed[side] += r.n;
    dayOf(r.d).unconfirmed[side] += r.n;
  }
  out.days.sort((x, y) => x.date.localeCompare(y.date));
  return out;
}

/** An open item without a pair and why (nearMissSql): `pairItemId` = its near pair on the other side, if any. */
export type NearMiss = { itemId: string; side: "a" | "b"; businessDate: string; reason: NearMissReason; pairItemId: string | null };

/**
 * The near-miss classifier (sql/breaks.ts nearMissSql), the one rule for day close and simulation: every open item of
 * config `configId` with business date `from`..`to`, live (`simRunId` null) or of simulation `simRunId`, with its reason
 * and near pair, judged under version `versionId`'s sides (sources, sign convention), each item against counterparts of
 * its own date or up to carry_over_days before it (as its date's close sees them). Reads only; on `tx`, a transaction
 * scoped to the config's space (withSpace).
 */
export async function classifyUnmatched(tx: InTx, i: { spaceId: string; configId: string; versionId: string; simRunId: string | null; from: string; to: string }): Promise<NearMiss[]> {
  const [v] = await tx.select({ spec: reconConfigVersions.spec }).from(reconConfigVersions)
    .where(and(eq(reconConfigVersions.spaceId, i.spaceId), eq(reconConfigVersions.configId, i.configId), eq(reconConfigVersions.id, i.versionId)));
  if (!v) throw new ApiError("not_found", "This recon version doesn't exist.");
  const { spec, sides } = await load(tx, i.spaceId, ReconSpec.parse(v.spec));
  const rows = (await tx.execute(nearMissSql({
    spaceId: i.spaceId, configId: i.configId, simRunId: i.simRunId, sides, oneWay: isOneWay(spec), current: currentRecord(tx)!, carry: await effectiveCarry(tx, i, spec.carry_over_days, i.from),
  }, i.from, i.to))) as unknown as { item_id: string; side: "a" | "b"; business_date: string; reason: NearMissReason; pair_item_id: string | null }[];
  return rows.map((r) => ({ itemId: r.item_id, side: r.side, businessDate: r.business_date, reason: r.reason, pairItemId: r.pair_item_id }));
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

/** A run's counters as answered: the projection a simulation stores beside them is its own field. */
const withoutProjection = (c: unknown): RunCounters => {
  const { projection: _, ...rest } = c as RunCounters & { projection?: unknown };
  return rest;
};

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
      from: r.dateFrom, to: r.dateTo, doneThrough: r.doneThrough, counters: withoutProjection(r.counters), error: r.error,
      startedAt: r.startedAt.toISOString(), finishedAt: iso(r.finishedAt),
      baseline: b ? { runId: b.id, versionId: b.versionId, version: versions.get(b.versionId) ?? 0 } : null,
      changes: isDraftSim && r.status === "succeeded" ? { gained: n("gained"), lost: n("lost"), repaired: n("repaired"), kind: n("kind") } : null,
      days: null,
      live: null,
      projection: isDraftSim && r.status === "succeeded" ? ((r.counters as { projection?: RunProjection }).projection ?? null) : null,
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

/**
 * A run's stored days when it is finalized and they have today's shape (`items`, `closed`, `breakReasons`: older ones
 * count as none);
 * null otherwise (GET run then queues finalizeRun, runDetail).
 */
function finalizedDays(run: RunRow): RunDay[] | null {
  const ok = run.finalized && Array.isArray(run.days) && (run.days as RunDay[]).every((d) => typeof d.closed === "boolean" && !!d.items && !!d.breakReasons);
  return ok ? (run.days as RunDay[]) : null;
}

/** The run as answered (also the answer of a run or simulation request); `withDays` adds its stored `days` (GET run). */
export async function runRow(tx: InTx, spaceId: string, configId: string, runId: string, withDays = false): Promise<ReconRunDto> {
  const run = await runOfConfig(tx, spaceId, configId, runId);
  const dto = (await runDtos(tx, spaceId, [run]))[0]!;
  if (!withDays) return dto;
  const days = finalizedDays(run);
  // the run's own dates only: the carry-over dates before them hold other runs' groups and breaks
  const own = (days ?? []).filter((d) => d.date >= run.dateFrom && d.date <= run.dateTo);
  const sum = (f: (d: RunDay) => number) => own.reduce((n, d) => n + f(d), 0);
  const passes = (d: RunDay, f: "matched" | "suggested") => Object.values(d.passes).reduce((n, p) => n + p[f], 0);
  return {
    ...dto, days,
    live: days && {
      matched: sum((d) => passes(d, "matched")), suggested: sum((d) => passes(d, "suggested")),
      breaks: { a: sum((d) => d.breaks.a), b: sum((d) => d.breaks.b) }, open: { a: sum((d) => d.open.a), b: sum((d) => d.open.b) },
      items: { a: sum((d) => d.items?.a ?? 0), b: sum((d) => d.items?.b ?? 0) },
      breakReasons: own.reduce<Record<string, { a: number; b: number }>>((m, d) => {
        for (const [reason, n] of Object.entries(d.breakReasons ?? {})) m[reason] = { a: (m[reason]?.a ?? 0) + n.a, b: (m[reason]?.b ?? 0) + n.b };
        return m;
      }, {}),
    },
  };
}

/**
 * A run's days (ReconRunDto.days) and its passes' distinct broken references, over its window `first`..`to` (its dates
 * and the carry over before them) as the items stand when it is called (the run's end, or after its close): matched groups and suggested ones whose items are still
 * suggested per (date, pass), whether the day closed, breaks of time (grace, close: break_pass null) and current records
 * (items not closed) per (date, side), broken items per (date,
 * pass) with distinct references (per day: a reference broken on two dates counts on each), open items per (date, side);
 * and per pass the distinct references of the window's items it broke (each once). Run once, at the run's
 * end in the worker, and stored with the run (recon_runs.days): a GET never scans the groups of 31 days (S1: ~200k a day).
 */
async function daysOf(tx: InTx, w: { spaceId: string; configId: string; simRunId: string | null; passes: number[]; first: string; from: string; to: string; recordSpaces: string[] }):
  Promise<{ days: RunDay[]; refs: Map<number, number> }> {
  const itemsIn = and(eq(reconItems.spaceId, w.spaceId), eq(reconItems.configId, w.configId), w.simRunId ? eq(reconItems.simRunId, w.simRunId) : isNull(reconItems.simRunId),
    sql`${reconItems.businessDate} between ${w.first}::date and ${w.to}::date`);
  const groupsIn = and(eq(matchGroups.spaceId, w.spaceId), eq(matchGroups.configId, w.configId), w.simRunId ? eq(matchGroups.simRunId, w.simRunId) : isNull(matchGroups.simRunId),
    isNull(matchGroups.reversedBy), sql`${matchGroups.businessDate} between ${w.first}::date and ${w.to}::date`);
  const matched = await tx.select({ d: matchGroups.businessDate, pass: matchGroups.passNo, n: count() }).from(matchGroups)
    .where(and(groupsIn, eq(matchGroups.kind, "auto"))).groupBy(matchGroups.businessDate, matchGroups.passNo);
  // a suggestion counts while its items are suggested: once day close broke them (the pair kept), they are breaks
  const suggested = await tx.select({ d: matchGroups.businessDate, pass: matchGroups.passNo, n: countDistinct(matchGroups.id) }).from(matchGroups)
    .innerJoin(matchMembers, and(eq(matchMembers.spaceId, matchGroups.spaceId), eq(matchMembers.groupId, matchGroups.id)))
    .innerJoin(reconItems, and(eq(reconItems.spaceId, matchMembers.spaceId), eq(reconItems.id, matchMembers.itemId), eq(reconItems.status, "suggested")))
    .where(and(groupsIn, eq(matchGroups.kind, "suggested"))).groupBy(matchGroups.businessDate, matchGroups.passNo);
  const brokenRecord = and(inArray(records.spaceId, w.recordSpaces), eq(records.id, reconItems.recordId), eq(records.businessDate, reconItems.businessDate));
  const isBroken = and(itemsIn, eq(reconItems.status, "break"), isNotNull(reconItems.breakPass));
  const broken = await tx.select({ d: reconItems.businessDate, pass: reconItems.breakPass, n: count(), refs: countDistinct(records.extRef) }).from(reconItems)
    .leftJoin(records, brokenRecord).where(isBroken).groupBy(reconItems.businessDate, reconItems.breakPass);
  const refs = await tx.select({ pass: reconItems.breakPass, refs: countDistinct(records.extRef) }).from(reconItems)
    .leftJoin(records, brokenRecord).where(isBroken).groupBy(reconItems.breakPass);
  // per (date, side, reason) in one pass over the window's items: waiting, current records (intake − replaced: an item
  // of a replaced record is closed), breaks of time (grace, day close: no pass broke them; a pass's Duplicate stays
  // under its pass) and breaks
  const states = await tx.select({
    d: reconItems.businessDate, side: reconItems.side, reason: reconItems.breakReason,
    open: sql<number>`count(*) filter (where ${reconItems.status} = 'open')`.mapWith(Number),
    current: sql<number>`count(*) filter (where ${reconItems.status} <> 'closed')`.mapWith(Number),
    timed: sql<number>`count(*) filter (where ${reconItems.status} = 'break' and ${reconItems.breakPass} is null)`.mapWith(Number),
    breaks: sql<number>`count(*) filter (where ${reconItems.status} = 'break')`.mapWith(Number),
    nr: sql<number>`count(*) filter (where ${reconItems.status} = 'not_required')`.mapWith(Number),
  }).from(reconItems).where(itemsIn).groupBy(reconItems.businessDate, reconItems.side, reconItems.breakReason);
  const closed = w.simRunId ? [] : await tx.select({ d: reconDays.businessDate }).from(reconDays).where(and(eq(reconDays.spaceId, w.spaceId), eq(reconDays.configId, w.configId),
    eq(reconDays.status, "closed"), sql`${reconDays.businessDate} between ${w.first}::date and ${w.to}::date`));
  const dates = new Set<string>();
  for (let d = w.from; d <= w.to; d = addDays(d, 1)) dates.add(d);
  for (const r of [...matched, ...suggested, ...broken, ...states.filter((x) => x.current > 0 || x.open > 0)]) dates.add(r.d);
  const perSide = (date: string, f: "open" | "current" | "timed" | "nr") => {
    const n = (side: string) => states.filter((x) => x.d === date && x.side === side).reduce((t, x) => t + x[f], 0);
    return { a: n("a"), b: n("b") };
  };
  const reasonsOn = (date: string) => states.filter((x) => x.d === date && x.breaks > 0);
  const days = [...dates].sort().map((date): RunDay => ({
    date,
    passes: Object.fromEntries(w.passes.map((no) => [String(no), {
      matched: matched.find((g) => g.d === date && g.pass === no)?.n ?? 0,
      suggested: suggested.find((g) => g.d === date && g.pass === no)?.n ?? 0,
      broken: broken.find((b) => b.d === date && b.pass === no)?.n ?? 0,
      brokenRefs: broken.find((b) => b.d === date && b.pass === no)?.refs ?? 0,
    }])),
    open: perSide(date, "open"),
    breaks: perSide(date, "timed"),
    items: perSide(date, "current"),
    breakReasons: Object.fromEntries([...new Set(reasonsOn(date).map((r) => r.reason ?? ""))].sort().map((reason) => [reason, {
      a: reasonsOn(date).find((r) => (r.reason ?? "") === reason && r.side === "a")?.breaks ?? 0,
      b: reasonsOn(date).find((r) => (r.reason ?? "") === reason && r.side === "b")?.breaks ?? 0,
    }])),
    ...(states.some((x) => x.d === date && x.nr > 0) ? { notRequired: perSide(date, "nr") } : {}),
    closed: closed.some((c) => c.d === date),
  }));
  return { days, refs: new Map(refs.map((r) => [r.pass!, r.refs])) };
}

/**
 * Writes a succeeded run's days (daysOf over its window, as its items stand) and its passes' broken references counted
 * once, and marks it finalized, under its row's lock; idempotent. `backfill`: the job a GET queued, which leaves a run
 * already finalized as it is. Called by the worker after a run and again
 * after its close, and by the backfill job a GET queues (pre-0032 runs, failed or old-shape days).
 */
export async function finalizeRun(on: Tx, spaceId: string, runId: string, o: { backfill?: boolean } = {}): Promise<void> {
  const mine = and(eq(reconRuns.spaceId, spaceId), eq(reconRuns.id, runId));
  await withSpace({ spaceIds: [spaceId], userId: null }, async (tx) => {
    const [r] = await tx.select().from(reconRuns).where(mine).for("update");
    if (r?.status !== "succeeded") return;
    // a backfill a GET queued finds it done already (a second GET, or the worker got there first)
    if (o.backfill && finalizedDays(r)) return;
    const { spec, recordSpaces } = await versionRead(tx, spaceId, r.configVersionId);
    const { days, refs } = await daysOf(tx, {
      spaceId, configId: r.configId, simRunId: r.mode === "simulation" ? r.id : null, passes: spec.passes.map((p) => p.no),
      first: addDays(r.dateFrom, -((r.counters as RunCounters | null)?.carry ?? await effectiveCarry(tx, { spaceId, configId: r.configId }, spec.carry_over_days, r.dateTo))), from: r.dateFrom, to: r.dateTo, recordSpaces,
    });
    // a reference broken on two dates of the run counts once: the steps counted it per date, the window's breaks count
    // each reference once. ponytail: the smaller of the two; it can still be high when the run re-broke a reference
    // across dates and the window also holds breaks of earlier runs (record the run on the item if that matters).
    // On the row's counters: a simulation stored its projection beside them.
    // Only on the first finalize: after the close (or later) the window's breaks are not the run's own any more, so a
    // second min could only drift from what the run did. A run marked not finalized after a failed refresh takes it once
    // more: the same value unless breaks of its window were resolved in between (Plan 5), which can lower it.
    const counters = r.counters as RunCounters;
    if (!r.finalized) {
      for (const p of spec.passes) {
        const pc = counters.passes?.[String(p.no)];
        if (pc) pc.brokenRefs = Math.min(pc.brokenRefs ?? pc.broken, refs.get(p.no) ?? 0);
      }
    }
    // a success clears the backfill's failed attempts, so a later outage starts its own count (review T1)
    await tx.update(reconRuns).set({ counters, days, finalized: true, finalizeAttempts: 0, finalizeError: null }).where(mine);
  }, on);
}

/**
 * After a live run's job closed its dates (schedule.ts runScheduled): finalized again, so its days show the breaks
 * the close made (`counters` stay what the run did). On a failure the run is marked not finalized, so the next GET
 * queues the backfill instead of showing the picture from before the close for good.
 */
export async function refreshRunDays(on: Tx, spaceId: string, runId: string): Promise<void> {
  try {
    await finalizeRun(on, spaceId, runId);
  } catch (e) {
    log.warn({ err: errorDetail(e), runId }, "recon run: days after the close failed");
    await withSpace({ spaceIds: [spaceId], userId: null }, (tx) => tx.update(reconRuns).set({ finalized: false })
      .where(and(eq(reconRuns.spaceId, spaceId), eq(reconRuns.id, runId))), on).catch((x: unknown) => log.warn({ err: errorDetail(x), runId }, "recon run: marking it for the backfill failed"));
  }
}

/** How many of run `runId`'s own dates are closed (recon_days); 0 for a run not found. */
export async function closedDates(on: Tx, spaceId: string, runId: string): Promise<number> {
  return withSpace({ spaceIds: [spaceId], userId: null }, async (tx) => {
    const [run] = await tx.select({ configId: reconRuns.configId, from: reconRuns.dateFrom, to: reconRuns.dateTo }).from(reconRuns)
      .where(and(eq(reconRuns.spaceId, spaceId), eq(reconRuns.id, runId)));
    if (!run) return 0;
    const [r] = await tx.select({ n: count() }).from(reconDays).where(and(eq(reconDays.spaceId, spaceId), eq(reconDays.configId, run.configId),
      eq(reconDays.status, "closed"), sql`${reconDays.businessDate} between ${run.from}::date and ${run.to}::date`));
    return r?.n ?? 0;
  }, on);
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

/**
 * The members of groups `ids` (their records read in `recordSpaces`), at most GROUP_MEMBERS_MAX per group (side A
 * first; a group pass can hold thousands), with each group's member count.
 */
async function membersOf(tx: InTx, spaceId: string, ids: string[], recordSpaces: string[]): Promise<Map<string, { members: RunGroupMember[]; count: number }>> {
  const out = new Map<string, { members: RunGroupMember[]; count: number }>();
  if (!ids.length) return out;
  const ranked = tx.select({
    groupId: matchMembers.groupId, side: matchMembers.side, itemId: matchMembers.itemId,
    rn: sql<number>`row_number() over (partition by ${matchMembers.groupId} order by ${matchMembers.side}, ${matchMembers.itemId})`.as("rn"),
    n: sql<number>`count(*) over (partition by ${matchMembers.groupId})`.mapWith(Number).as("n"),
  }).from(matchMembers).where(and(eq(matchMembers.spaceId, spaceId), inArray(matchMembers.groupId, ids))).as("m");
  const rows = await tx.select({ id: ranked.groupId, side: ranked.side, n: ranked.n, recordId: reconItems.recordId, date: reconItems.businessDate, ref: records.extRef, amount: records.amountMinor, ccy: records.currency })
    .from(ranked).innerJoin(reconItems, and(eq(reconItems.spaceId, spaceId), eq(reconItems.id, ranked.itemId)))
    .leftJoin(records, and(inArray(records.spaceId, recordSpaces), eq(records.id, reconItems.recordId), eq(records.businessDate, reconItems.businessDate)))
    .where(lte(ranked.rn, GROUP_MEMBERS_MAX)).orderBy(asc(ranked.side), asc(reconItems.recordId));
  for (const r of rows) {
    const g = out.get(r.id) ?? { members: [], count: Number(r.n) };
    g.members.push({ side: r.side as "a" | "b", recordId: r.recordId, extRef: r.ref, amountMinor: r.amount?.toString() ?? null, currency: r.ccy, businessDate: r.date });
    out.set(r.id, g);
  }
  return out;
}

const inSpace = <T>(ctx: Ctx, fn: (tx: InTx, spaceId: string) => Promise<T>) =>
  withSpace({ spaceIds: [ctx.space!.id], userId: ctx.user.id }, (tx) => fn(tx, ctx.space!.id));

/** Backfill jobs (finalizeRun) a run gets before GET stops queueing them, and the least time between two. */
export const FINALIZE_ATTEMPTS_MAX = 3;
const FINALIZE_RETRY_SECONDS = 300;

/**
 * The backfill job a GET queued (recon.heavy, data { finalize }): finalizeRun; a failure is counted and its error
 * (name and code, never a query's text) kept on the run, so GET stops queueing after FINALIZE_ATTEMPTS_MAX. The job
 * itself completes (no pg-boss retry: the next GET's queues the next attempt).
 */
export async function backfillRun(on: Tx, spaceId: string, runId: string): Promise<void> {
  try {
    await finalizeRun(on, spaceId, runId, { backfill: true });
  } catch (e) {
    const d = errorDetail(e);
    log.warn({ err: d, runId }, "recon run: backfill of its days failed");
    await withSpace({ spaceIds: [spaceId], userId: null }, (tx) => tx.update(reconRuns)
      .set({ finalizeAttempts: sql`${reconRuns.finalizeAttempts} + 1`, finalizeError: [d.name, d.code].filter(Boolean).join(" ") })
      .where(and(eq(reconRuns.spaceId, spaceId), eq(reconRuns.id, runId))), on);
  }
}

/**
 * GET …/runs/:runId. Reads only (the API's 5 s pool never aggregates a run's days): a succeeded run not finalized
 * answers days and live null and queues finalizeRun on the worker (recon.heavy, one job per run), which the screen's
 * next poll then reads.
 */
export async function runDetail(ctx: Ctx, configId: string, runId: string): Promise<ReconRunDto> {
  const dto = await inSpace(ctx, (tx, spaceId) => runRow(tx, spaceId, configId, runId, true));
  if (dto.status === "succeeded" && dto.days === null) {
    const [r] = await inSpace(ctx, (tx, spaceId) => tx.select({ attempts: reconRuns.finalizeAttempts }).from(reconRuns)
      .where(and(eq(reconRuns.spaceId, spaceId), eq(reconRuns.id, runId))));
    // at most one job per run in FINALIZE_RETRY_SECONDS, and none after FINALIZE_ATTEMPTS_MAX failures (days stay null)
    if ((r?.attempts ?? 0) < FINALIZE_ATTEMPTS_MAX) {
      await enqueue(QUEUES.reconHeavy, { spaceId: ctx.space!.id, runId, finalize: true }, { key: `finalize:${runId}`, singletonSeconds: FINALIZE_RETRY_SECONDS })
        .catch((e: unknown) => log.warn({ err: errorDetail(e), runId }, "recon run: queueing its days failed"));
    }
  }
  return dto;
}

/** GET …/runs: the config's runs and draft simulations, newest first unless `sort` says otherwise. */
export function runPage(ctx: Ctx, configId: string, q: ReconRunListQuery): Promise<Page<ReconRunDto>> {
  return inSpace(ctx, async (tx, spaceId) => {
    await configExists(tx, spaceId, configId);
    const where = and(eq(reconRuns.spaceId, spaceId), eq(reconRuns.configId, configId), isNull(reconRuns.baselineOf),
      q.mode ? eq(reconRuns.mode, q.mode) : undefined, q.versionId ? eq(reconRuns.configVersionId, q.versionId) : undefined,
      q.records ? and(ne(reconRuns.mode, "simulation"), runHasRecordsSql()) : undefined);
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
    const carry = (run.counters as RunCounters | null)?.carry ?? await effectiveCarry(tx, { spaceId, configId }, spec.carry_over_days, run.dateTo);
    const scopeI = run.mode === "simulation" ? eq(reconItems.simRunId, run.id) : isNull(reconItems.simRunId);
    const inWindow = (c: typeof reconItems.businessDate | typeof matchGroups.businessDate) =>
      sql`${c} between ${addDays(run.dateFrom, -carry)}::date and ${run.dateTo}::date`;
    const scopeG = run.mode === "simulation" ? eq(matchGroups.simRunId, run.id) : isNull(matchGroups.simRunId);
    // the item's group now: a group of the run's scope it is a member of, not reversed. A plain join of members and
    // groups, so the planner joins it by hash or index (a correlated IN in the join condition compared every item with
    // every group: past the 5 s timeout at 5,000 items a side)
    const cur = tx.select({
      itemId: matchMembers.itemId, id: matchGroups.id, passNo: matchGroups.passNo, kind: matchGroups.kind, businessDate: matchGroups.businessDate, evidence: matchGroups.evidence,
    }).from(matchMembers).innerJoin(matchGroups, and(eq(matchGroups.spaceId, matchMembers.spaceId), eq(matchGroups.id, matchMembers.groupId)))
      .where(and(eq(matchMembers.spaceId, spaceId), eq(matchGroups.configId, configId), scopeG, isNull(matchGroups.reversedBy))).as("cur");
    // the date an item counts on, as daysOf counts it: a pair (matched, suggested) on its group's (the latest member's,
    // so its own is within carry over before it), every other item on its own
    const countsOn = sql`case when ${reconItems.status} in ('matched', 'suggested') then coalesce(${cur.businessDate}, ${reconItems.businessDate}) else ${reconItems.businessDate} end`;
    const where = and(
      eq(reconItems.spaceId, spaceId), eq(reconItems.configId, configId),
      scopeI,
      sql`${reconItems.businessDate} between ${addDays(run.dateFrom, -carry)}::date and ${run.dateTo}::date`,
      q.dates === "own" ? sql`${countsOn} between ${run.dateFrom}::date and ${run.dateTo}::date` : undefined,
      q.dates === "carried" ? sql`${countsOn} < ${run.dateFrom}::date` : undefined,
      q.status ? eq(reconItems.status, q.status) : undefined, q.side ? eq(reconItems.side, q.side) : undefined,
      q.reason ? and(eq(reconItems.status, "break"), eq(reconItems.breakReason, q.reason)) : undefined,
      // pass: a member of one of its groups, or an item it broke. Per item (an index lookup each), so the page walks the
      // items in date order and stops at its last row: an IN over the pass's members built the whole window's set
      // first (REC-P1 gate 3: past the 5 s timeout for a pass holding 1.2M items over 31 days; 149 ms this way)
      q.pass ? or(
        exists(tx.select(countOne).from(matchMembers).innerJoin(matchGroups, and(eq(matchGroups.spaceId, matchMembers.spaceId), eq(matchGroups.id, matchMembers.groupId)))
          .where(and(eq(matchMembers.spaceId, reconItems.spaceId), eq(matchMembers.itemId, reconItems.id), eq(matchGroups.configId, configId), scopeG, isNull(matchGroups.reversedBy),
            eq(matchGroups.passNo, q.pass), inWindow(matchGroups.businessDate)))),
        eq(reconItems.breakPass, q.pass),
      ) : undefined,
      q.date ? and(sql`${reconItems.businessDate} between ${addDays(q.date, -carry)}::date and ${q.date}::date`,
        sql`${countsOn} = ${q.date}::date`) : undefined,
    );
    const record = and(inArray(records.spaceId, recordSpaces), eq(records.id, reconItems.recordId), eq(records.businessDate, reconItems.businessDate));
    // a proposal's item and its record (DEC-047): joined once for the page, as the item's own
    const pi = alias(reconItems, "pi"), pr = alias(records, "pr");
    const page = await pageQuery({
      rows: tx.select({
        i: reconItems, g: { id: cur.id, passNo: cur.passNo, kind: cur.kind, businessDate: cur.businessDate, evidence: cur.evidence }, ref: records.extRef, amount: records.amountMinor, ccy: records.currency,
        p: { id: pi.id, side: pi.side, date: pi.businessDate, ref: pr.extRef, amount: pr.amountMinor, ccy: pr.currency },
      })
        .from(reconItems).leftJoin(cur, eq(cur.itemId, reconItems.id)).leftJoin(records, record)
        .leftJoin(pi, and(eq(pi.spaceId, reconItems.spaceId), eq(pi.id, reconItems.proposedItemId)))
        .leftJoin(pr, and(inArray(pr.spaceId, recordSpaces), eq(pr.id, pi.recordId), eq(pr.businessDate, pi.businessDate)))
        .where(where).$dynamic(),
      count: tx.select(countOne).from(reconItems).leftJoin(cur, eq(cur.itemId, reconItems.id)).where(where).$dynamic(),
      orderBy: sortSql(q.sort, { businessDate: reconItems.businessDate }, "businessDate", reconItems.id),
      query: q, on: tx, map: (r) => r,
    });
    const members = await membersOf(tx, spaceId, [...new Set(page.items.flatMap((r) => (r.g ? [r.g.id] : [])))], recordSpaces);
    return {
      ...page,
      items: page.items.map(({ i, g, ref, amount, ccy, p }): ReconRunItemDto => ({
        id: i.id, recordId: i.recordId, side: i.side as "a" | "b", status: i.status as ItemStatus, businessDate: i.businessDate, breakReason: i.breakReason,
        breakPass: i.breakPass, extRef: ref, amountMinor: amount?.toString() ?? null, currency: ccy,
        // a proposal stands for a break only (one taken up since is the item's history, not a pair to accept)
        proposed: i.status === "break" && p?.id && p.date && i.proposedPass !== null ? {
          itemId: p.id, side: p.side as "a" | "b", passNo: i.proposedPass, extRef: p.ref, amountMinor: p.amount?.toString() ?? null, currency: p.ccy, businessDate: p.date,
        } : null,
        group: g ? { id: g.id, passNo: g.passNo, kind: g.kind as GroupKind, businessDate: g.businessDate, evidence: g.evidence, members: members.get(g.id)?.members ?? [], memberCount: members.get(g.id)?.count ?? 0 } : null,
      })),
    };
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
    const groups = ids.length ? await tx.select({ id: matchGroups.id, passNo: matchGroups.passNo, kind: matchGroups.kind }).from(matchGroups)
      .where(and(eq(matchGroups.spaceId, spaceId), inArray(matchGroups.id, ids))) : [];
    const members = await membersOf(tx, spaceId, ids, recordSpaces);
    const groupOf = (id: string | null) => {
      const g = groups.find((x) => x.id === id);
      return g ? { id: g.id, passNo: g.passNo, kind: g.kind as GroupKind, members: members.get(g.id)?.members ?? [], memberCount: members.get(g.id)?.count ?? 0 } : null;
    };
    return {
      ...page,
      items: page.items.map((r): ReconSimChangeDto => ({
        id: r.id, change: r.change as SimChange, businessDate: r.businessDate, draft: groupOf(r.draftGroupId), published: groupOf(r.publishedGroupId),
      })),
    };
  });
}
