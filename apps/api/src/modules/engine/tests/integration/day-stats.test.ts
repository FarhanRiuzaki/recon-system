// recon_day_stats (the dashboard's rollup, stats.ts): recomputed whole from the engine's tables, it equals a direct
// count (Operation result's counts, the items themselves) on the fixture, also after a resolution and a reversal; a
// second recompute writes the same row; another space's scope neither reads nor writes it (RLS).
import { beforeEach, describe, expect, it } from "bun:test";
import type { ResultCountsDto } from "@starterkit/shared/contracts/results";
import { and, eq, isNull, sql } from "drizzle-orm";
import { call, signIn } from "../../../../../test/helpers/app";
import { asAppRole } from "../../../../../test/helpers/app-role";
import { db, type InTx } from "../../../../kernel/db";
import { withSpace } from "../../../spaces";
import { matchGroups, reconDayStats, reconItems } from "../../schema";
import { boss, QUEUES } from "../../../../kernel/jobs";
import { reconConfigs } from "../../../recon";
import { engineHandlers } from "../../jobs";
import { BACKFILL_DAYS, queueBackfill, queueDay, recomputeDayStats, STATS_DELAY_MS, sweepStats } from "../../stats";
import { D, D1, type DashboardFixture, noon, seedDashboard } from "../dashboard-fixture";
import { ensureMonthPartitions } from "../../../../kernel/partitions";
import { records } from "../../../ingest";
import { closeDay } from "../../breaks";
import { addDays, runRecon } from "../../service";
import { ccyEq, makeSource, plainSource, put, recon, spec } from "../fixtures";

let F: DashboardFixture;
beforeEach(async () => { F = await seedDashboard(); });

const recompute = (space: string, cfg: string, date = D) => withSpace({ spaceIds: [space], userId: null }, (tx) => recomputeDayStats(tx, space, cfg, date));
const rowOf = async (space: string, cfg: string, date = D) =>
  (await withSpace({ spaceIds: [space], userId: null }, (tx) => tx.select().from(reconDayStats).where(and(eq(reconDayStats.configId, cfg), eq(reconDayStats.businessDate, date)))))[0]!;
/** Operation result's counts of R1 on D, as its list answers them. */
async function listCounts(token: string) {
  const r = await call("GET", `/v1/spaces/${F.A}/recons/${F.R1.configId}/results/counts?dateFrom=${D}&dateTo=${D}`, { token });
  return ((await r.json()) as ResultCountsDto).counts;
}
const rowsOf = (results: unknown) => Object.fromEntries(Object.entries(results as Record<string, [number, number]>).map(([k, [rows]]) => [k, rows]));
const recordsOf = (results: unknown) => Object.values(results as Record<string, [number, number]>).reduce((n, [, r]) => n + r, 0);
/** Live items of R1 dated D, counted directly. */
const itemsOnD = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(reconItems)
  .where(and(eq(reconItems.configId, F.R1.configId), eq(reconItems.businessDate, D), isNull(reconItems.simRunId))))[0]!.n;

describe("recon_day_stats", () => {
  it("equals Operation result's counts and the items of the date", async () => {
    await recompute(F.A, F.R1.configId);
    const row = await rowOf(F.A, F.R1.configId);
    const token = await signIn("viewer");
    expect(rowsOf(row.results)).toEqual(await listCounts(token) as Record<string, number>);
    expect(rowsOf(row.results)).toEqual({ matched: 1, matched_by_hand: 1, waiting_approval: 1, unmatch: 1, written_off: 1 });
    expect(recordsOf(row.results)).toBe(await itemsOnD());
    expect((row.results as Record<string, [number, number]>).matched).toEqual([1, 2]);
    // P2, P3, P4, P5 broke; P5 written off 900 IDR; resolved P2 (a day and 12 h after D's start) and P5 (12 h)
    expect(row.broke).toBe(4);
    expect(row.writtenOff).toEqual({ IDR: ["900", 1] });
    expect([...row.resolveMinutes].sort((a, b) => a - b)).toEqual([12 * 60, 36 * 60]);
  });

  it("follows a resolution and a reversal once recomputed", async () => {
    const token = await signIn("viewer");
    const closed = await call("POST", `/v1/spaces/${F.A}/breaks/${F.I.P4}/close`, { token, body: { resolution: "DUPLICATE", note: "Sent twice" } });
    expect(closed.status).toBe(200);
    // the auto group reversed: its two items become lone rows
    await db.update(matchGroups).set({ reversedBy: Bun.randomUUIDv7(), reversedAt: noon(D) }).where(eq(matchGroups.id, F.G.auto!));
    await recompute(F.A, F.R1.configId);
    const row = await rowOf(F.A, F.R1.configId);
    expect(rowsOf(row.results)).toEqual(await listCounts(token) as Record<string, number>);
    expect(rowsOf(row.results).closed).toBe(1);
    expect(rowsOf(row.results).matched).toBe(2);
    expect(recordsOf(row.results)).toBe(await itemsOnD());
    expect(row.resolveMinutes.length).toBe(3);
  });

  it("a second recompute writes the same row", async () => {
    await recompute(F.A, F.R1.configId);
    const a = await rowOf(F.A, F.R1.configId);
    await recompute(F.A, F.R1.configId);
    const b = await rowOf(F.A, F.R1.configId);
    expect({ ...b, computedAt: null }).toEqual({ ...a, computedAt: null });
  });

  it("another space's scope neither reads nor writes a space's rows", async () => {
    await recompute(F.A, F.R1.configId);
    // as the app role (the test database connects as a superuser, which skips every policy)
    const as = <T>(space: string, fn: (tx: InTx) => Promise<T>) => withSpace({ spaceIds: [space], userId: null }, async (tx) => { await asAppRole(tx); return fn(tx); });
    expect((await as(F.A, (tx) => tx.select().from(reconDayStats))).length).toBe(1);
    expect(await as(F.B, (tx) => tx.select().from(reconDayStats))).toEqual([]);
    const e = await as(F.B, (tx) => tx.insert(reconDayStats).values({ spaceId: F.A, configId: F.R1.configId, businessDate: D1 })).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
  });
});

describe("recon.stats jobs", () => {
  const jobsOf = async (key: string) => (await boss()).findJobs(QUEUES.reconStats, { key });

  it("a resolution queues one recompute of its config and date, a minute out; more changes merge into it", async () => {
    await (await boss()).deleteAllJobs();
    const token = await signIn("viewer");
    const before = Date.now();
    expect((await call("POST", `/v1/spaces/${F.A}/breaks/${F.I.P4}/close`, { token, body: { resolution: "DUPLICATE", note: "Sent twice" } })).status).toBe(200);
    const [job, ...more] = await jobsOf(`${F.R1.configId}:${D}`);
    expect(more).toEqual([]);
    expect(job!.data).toEqual({ spaceId: F.A, configId: F.R1.configId, date: D });
    expect(new Date(job!.startAfter).getTime()).toBeGreaterThanOrEqual(before + STATS_DELAY_MS - 1000);
    expect(await queueDay(F.A, F.R1.configId, D)).toBeNull();
    expect((await jobsOf(`${F.R1.configId}:${D}`)).length).toBe(1);
  });

  it("a run that late-matches an unmatch of 4 days before queues that date: its row moves from unmatch to matched_late (C1)", async () => {
    const D4 = addDays(D, -4);
    await db.transaction(async (tx) => {
      await ensureMonthPartitions(tx, records, new Date(`${D4}T00:00:00Z`), 1);
      await ensureMonthPartitions(tx, reconItems, new Date(`${D4}T00:00:00Z`), 1);
    });
    const exact = { no: 1, name: "Exact", cardinality: "1:1", blocking: [], accept: "auto", on_ambiguous: "break", predicates: [{ op: "eq", field: "ext_ref" }, { op: "eq", field: "amount_minor" }, ccyEq] };
    const [sa, sb] = [await makeSource(F.A, plainSource()), await makeSource(F.A, plainSource())];
    const r = await recon(F.A, spec(sa.sourceId, sb.sourceId, [exact], 7));
    await put(sa, [{ ref: "L1", amount: 100n, date: D4 }]);
    await runRecon(db, { ...r, mode: "daily", from: D4 });
    expect(await closeDay(db, r, D4, new Date("2026-12-31T00:00:00+07:00"))).toBe("closed");
    await recompute(F.A, r.configId, D4);
    expect(rowsOf((await rowOf(F.A, r.configId, D4)).results)).toEqual({ unmatch: 1 });

    await (await boss()).deleteAllJobs();
    await put(sb, [{ ref: "L1", amount: 100n, date: D }]);
    await runRecon(db, { ...r, mode: "daily", from: D }); // the run's own dates: D alone
    const handle = engineHandlers(db)[QUEUES.reconStats]!;
    for (const d of [D4, D]) {
      const jobs = await jobsOf(`${r.configId}:${d}`);
      expect(jobs.length).toBe(1);
      await handle({ id: "j", data: jobs[0]!.data });
    }
    expect(rowsOf((await rowOf(F.A, r.configId, D4)).results)).toEqual({});
    expect(rowsOf((await rowOf(F.A, r.configId, D)).results)).toEqual({ matched_late: 1 });
  }, 30_000);

  it("the backfill queues each date with results and no row, back BACKFILL_DAYS, once (C2)", async () => {
    const b = await boss();
    await b.deleteAllJobs();
    await recompute(F.A, F.R2.configId, D);
    const handle = engineHandlers(db)[QUEUES.reconStats]!;
    await handle({ id: "j", data: { backfill: true } });
    const queued = async () => (await b.fetch(QUEUES.reconStats, { batchSize: 100 })).map((j) => j.data as { configId: string; date: string });
    const jobs = await queued();
    // R1 on D and D1, RB on D; R2's D has its row; dates before hold no results
    expect(jobs.map((j) => `${j.configId}:${j.date}`).sort()).toEqual([`${F.R1.configId}:${D}`, `${F.R1.configId}:${D1}`, `${F.RB.configId}:${D}`].sort());
    expect(BACKFILL_DAYS).toBeGreaterThanOrEqual(184);
    for (const j of jobs) await handle({ id: "j", data: j });
    await b.deleteAllJobs();
    await handle({ id: "j", data: { backfill: true } });
    expect(await queued()).toEqual([]);
    // the worker queues the backfill under one key: a second start while one waits adds none
    expect(await queueBackfill()).not.toBeNull();
    expect(await queueBackfill()).toBeNull();
  });

  it("the job writes its row", async () => {
    const handle = engineHandlers(db)[QUEUES.reconStats]!;
    await handle({ id: "j", data: { spaceId: F.A, configId: F.R1.configId, date: D } });
    expect(rowsOf((await rowOf(F.A, F.R1.configId)).results).matched).toBe(1);
  });

  it("the sweep only queues a job per config and date, due now; one failing never stops the others (I4)", async () => {
    await (await boss()).deleteAllJobs();
    await sweepStats(db, noon(D1));
    const all = () => withSpace({ spaceIds: [F.A, F.B, F.C], userId: null }, (tx) => tx.select({ c: reconDayStats.configId, d: reconDayStats.businessDate }).from(reconDayStats));
    expect(await all()).toEqual([]);
    const jobs = await (await boss()).fetch(QUEUES.reconStats, { batchSize: 100 });
    expect(jobs.length).toBe(3 * 7);
    expect(jobs.filter((j) => (j.data as { configId: string }).configId === F.R1.configId).map((j) => (j.data as { date: string }).date).sort())
      .toEqual(["2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01", D, D1]);
    // R2 gone: its 7 jobs fail (no config to write a row of), the 14 others still write theirs
    await db.delete(reconConfigs).where(eq(reconConfigs.id, F.R2.configId));
    const handle = engineHandlers(db)[QUEUES.reconStats]!;
    const done = await Promise.allSettled(jobs.map((j) => handle({ id: j.id, data: j.data })));
    expect(done.filter((x) => x.status === "rejected").length).toBe(7);
    expect((await all()).length).toBe(2 * 7);
  });
});
