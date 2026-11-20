// The engine (spec §8–§10): a run of one config version over business dates, set-based in PostgreSQL (spike S1). The
// run row commits first; then each business date D of the range is one step, one transaction under withSpace scoped to
// the config's space (a source shared to it is read through the records policies, DEC-042) and configLock (one config
// never runs twice at once, spec §9): intake of both sides' records of D − carry_over_days … D, then the passes in
// order over open items of that window only, then the run's counters (the step's marker). A failed step rolls back
// alone and marks the run failed. A step run again finds nothing new: intake is once per record, passes read open
// items only, so a rerun adds no group and loses no item (Review Focus 3).
//
// A pass's choice is in sql/pass.ts: mutual unique best first, repeated while it pairs (taking a pair can make another
// pair the unique best); then the ties go to on_ambiguous: break (sql/breaks.ts) or suggest. Suggested groups never
// count as matched (DEC-046): their items stay `suggested`, outside later passes, counted open by match rate.
import { ReconSpec } from "@starterkit/shared/contracts/recon";
import { recordFields } from "@starterkit/shared/recon";
import { and, count, eq, sql, type SQL } from "drizzle-orm";
import type { InTx, Tx } from "../../kernel/db";
import { ApiError, errorDetail } from "../../kernel/errors";
import { log } from "../../kernel/log";
import { configLock } from "../../kernel/locks";
import { ensureMonthPartitions } from "../../kernel/partitions";
import { currentRecord, todayIn } from "../ingest";
import { checkReconSpec, reconConfigVersions } from "../recon";
import { readableSources } from "../sources";
import { withSpace } from "../spaces";
import { reconItems, reconRuns, RUN_MODES } from "./schema";
import { groupBreakSql, tieBreakSql } from "./sql/breaks";
import { intakeSql } from "./sql/intake";
import { acceptSql, groupAcceptSql, type SideRef, type StepCtx, tieSuggestSql } from "./sql/pass";

export type RunMode = (typeof RUN_MODES)[number];
/** What a pass did over the run: groups it accepted, groups it suggested, items it broke as ambiguous. */
export type PassCounters = { matched: number; suggested: number; broken: number };
/** A run's counters: items taken in per side, per pass (by number), and items still open per side in the window after. */
export type RunCounters = { intake: { a: number; b: number }; passes: Record<string, PassCounters>; open: { a: number; b: number } };
export type RunInput = {
  spaceId: string; configId: string; versionId: string; mode: RunMode;
  /** Business dates (yyyy-mm-dd), at most RANGE_MAX_DAYS; both default to today in Asia/Jakarta. */
  from?: string; to?: string;
};
export type RunSummary = { runId: string; counters: RunCounters };

/** The longest range one run covers (Plan 3 Task 3: a day by default, 31 at most). */
export const RANGE_MAX_DAYS = 31;
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
 * Version `versionId` of the config and its sides' sources as the space reads them; refused when the version is not
 * the published one (a simulation runs a draft too), a side's source is not readable here, or the spec's check fails
 * (every field on the sides' whitelists).
 */
async function load(tx: InTx, i: RunInput): Promise<Loaded> {
  const [v] = await tx.select({ status: reconConfigVersions.status, spec: reconConfigVersions.spec }).from(reconConfigVersions)
    .where(and(eq(reconConfigVersions.spaceId, i.spaceId), eq(reconConfigVersions.configId, i.configId), eq(reconConfigVersions.id, i.versionId)));
  if (!v) throw new ApiError("not_found", "This recon version doesn't exist.");
  if (i.mode !== "simulation" && v.status !== "published") throw new ApiError("invalid_state", "Only the published version of a recon runs.");
  const spec = ReconSpec.parse(v.spec);
  const found = await readableSources(tx, i.spaceId, spec.sides.map((s) => s.source_id));
  const sides = spec.sides.map((s) => {
    const src = found.get(s.source_id);
    if (!src?.spec) throw new ApiError("bad_request", `Side ${s.key.toUpperCase()}: this space can't read a published version of its source.`);
    return { key: s.key, sourceSpaceId: src.spaceId, sourceId: s.source_id, fields: recordFields(src.spec), spec: src.spec };
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
    // every item read was locked by this statement, so each claim succeeds; anything else is a bug: roll the step back
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
  // a pass of equalities only splits its candidates by key: taking one key's pair changes no other key, one round does
  const rounds = p.predicates.every((q) => q.op === "eq" || q.op === "eq_normalized") ? 1 : ROUNDS_MAX;
  for (let r = 0; r < rounds && (await write(acceptSql(c, p), accepted)) > 0; r++);
  if (p.on_ambiguous === "break") out.broken += (await one<{ items: number }>(tx, tieBreakSql(c, p))).items;
  else for (let r = 0; r < ROUNDS_MAX && (await write(tieSuggestSql(c, p), "suggested")) > 0; r++);
}

/**
 * Runs version `versionId` of config `configId` over business dates `from`..`to` on `on` (the API's db or the
 * worker's workerDb). `simulation` writes items of its own run and never touches live ones. Answers the run's id and
 * counters; a failure marks the run failed with the error's message and throws it.
 */
export async function runRecon(on: Tx, i: RunInput): Promise<RunSummary> {
  const today = todayIn(new Date());
  const from = i.from ?? i.to ?? today, to = i.to ?? from;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new ApiError("bad_request", "Pick a business date range that starts on or before its end.");
  if (days(from, to) > RANGE_MAX_DAYS) throw new ApiError("bad_request", `A run covers at most ${RANGE_MAX_DAYS} business dates.`);
  const scope = { spaceIds: [i.spaceId], userId: null };
  const runId = Bun.randomUUIDv7();
  const { spec, sides } = await withSpace(scope, async (tx) => {
    const l = await load(tx, i);
    await tx.insert(reconRuns).values({ id: runId, spaceId: i.spaceId, configId: i.configId, configVersionId: i.versionId, mode: i.mode, dateFrom: from, dateTo: to });
    return l;
  }, on);
  const carry = spec.carry_over_days;
  const counters: RunCounters = {
    intake: { a: 0, b: 0 }, passes: Object.fromEntries(spec.passes.map((p) => [String(p.no), { matched: 0, suggested: 0, broken: 0 }])), open: { a: 0, b: 0 },
  };
  const simRunId = i.mode === "simulation" ? runId : null;
  try {
    const first = addDays(from, -carry);
    const months = (Number(to.slice(0, 4)) - Number(first.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(first.slice(5, 7)) + 1;
    await on.transaction((tx) => ensureMonthPartitions(tx, reconItems, new Date(`${first}T00:00:00Z`), months));
    for (let d = from; d <= to; d = addDays(d, 1)) {
      await withSpace(scope, async (tx) => {
        await configLock(tx, i.configId);
        const c: StepCtx = {
          spaceId: i.spaceId, configId: i.configId, versionId: i.versionId, runId, simRunId, sides, lo: addDays(d, -carry), hi: d, current: currentRecord(tx)!,
        };
        for (const s of [0, 1] as const) counters.intake[sides[s].key] += (await one<{ n: number }>(tx, intakeSql(c, s, spec.sides[s].filter))).n;
        for (const p of spec.passes) await runPass(tx, c, p, counters.passes[String(p.no)]!);
        await tx.update(reconRuns).set({ counters }).where(and(eq(reconRuns.spaceId, i.spaceId), eq(reconRuns.id, runId)));
      }, on);
    }
    await withSpace(scope, async (tx) => {
      const open = await tx.select({ side: reconItems.side, n: count() }).from(reconItems).where(and(
        eq(reconItems.spaceId, i.spaceId), eq(reconItems.configId, i.configId), eq(reconItems.status, "open"),
        simRunId ? eq(reconItems.simRunId, simRunId) : sql`${reconItems.simRunId} is null`,
        sql`${reconItems.businessDate} between ${first}::date and ${to}::date`,
      )).groupBy(reconItems.side);
      for (const r of open) counters.open[r.side as "a" | "b"] = r.n;
      await tx.update(reconRuns).set({ counters, status: "succeeded", finishedAt: sql`now()` }).where(and(eq(reconRuns.spaceId, i.spaceId), eq(reconRuns.id, runId)));
    }, on);
  } catch (e) {
    // a person reads `error`: an ApiError's sentence, never a query's text (Drizzle's message holds the SQL and its values)
    if (!(e instanceof ApiError)) log.error({ err: errorDetail(e), runId }, "recon run failed");
    const error = e instanceof ApiError ? e.message : "The run stopped on an internal error. Run it again; if it fails again, tell your admin.";
    await withSpace(scope, (tx) => tx.update(reconRuns).set({ status: "failed", error, finishedAt: sql`now()` })
      .where(and(eq(reconRuns.spaceId, i.spaceId), eq(reconRuns.id, runId))), on);
    throw e;
  }
  return { runId, counters };
}
