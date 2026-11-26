// The schedule, grace, carry over, catch-up and day close (Plan 3 Task 6): the minute's dispatch (on the test's own pool:
// it writes pg-boss jobs, which the test database's app role may not) and the tick / daily jobs as the app role
// (appRoleDb, as the worker's workerDb), run by hand at a chosen `now`, on records written directly.
// - an interval recon's ticks take only what is new; an item past grace breaks, and a late counterpart closes that
//   break as AUTO_MATCHED_LATE_DATA (carry over 1);
// - carry over 0 (KSEI) never pairs a closed day's break with the next day's data; carry over 7 does;
// - a daily recon whose worker was down: the stale run is failed, one run covers every date since the last closed one,
//   each closes; a day whose data isn't complete waits until close + grace, then closes marked incomplete;
// - a manual run closes its due dates too, and never runs a closed one (Captain);
// - intake per chunk; the default range of a manual run (the day after the last closed one); sourceHealth's inputs from the recons.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { ReconRunDto, TodayDto } from "@starterkit/shared/contracts/recon";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { appRoleDb } from "../../../../../test/helpers/app-role";
import { db } from "../../../../kernel/db";
import { boss } from "../../../../kernel/jobs";
import { ensureMonthPartitions } from "../../../../kernel/partitions";
import { records, sourceCursors, sourceStates } from "../../../ingest";
import { reconHealthInputs, reconSourceUses } from "../../../recon";
import { calendars } from "../../../sources";
import { spaceMembers, spaces, withSpace } from "../../../spaces";
import { users } from "../../../users";
import { holdTx } from "../../../../../test/helpers/db";
import { reconConfigVersions } from "../../../recon";
import { closeDay, sweepClosed } from "../../breaks";
import { CLOSED_DAY, RUN_STOPPED } from "../../jobs";
import { alertStale, dispatch, refreshCovering, runScheduled } from "../../schedule";
import { reconLive, reconTrend, todayDto } from "../../today";
import type { Ctx } from "../../../auth";
import { reconDays, reconItems, reconRuns } from "../../schema";
import { classifyUnmatched, createRun, execRun, runRecon, type RunCounters } from "../../service";
import { ccyEq, D, D1, makeSource, plainSource, put, recon, spec, type Src, U } from "../fixtures";

type Probe = Awaited<ReturnType<typeof appRoleDb>>;
let probe: Probe, A: string;

const at = (s: string) => new Date(`${s}+07:00`);
const exact = { no: 1, name: "Exact", cardinality: "1:1", blocking: [], accept: "auto", on_ambiguous: "break", predicates: [{ op: "eq", field: "ext_ref" }, { op: "eq", field: "amount_minor" }, ccyEq] };
const sides = async () => [await makeSource(A, plainSource()), await makeSource(A, plainSource())] as [Src, Src];
const interval = (a: string, b: string, carry = 1) => ({ ...spec(a, b, [exact], carry), schedule: { kind: "interval", every_minutes: 2 } });
/** Source `s` complete through `t` (its cursor, as ingest writes it). */
const complete = (s: Src, t: Date) => db.insert(sourceCursors).values({ spaceId: s.spaceId, sourceId: s.sourceId, completeThrough: t })
  .onConflictDoUpdate({ target: [sourceCursors.spaceId, sourceCursors.sourceId], set: { completeThrough: t } });

/**
 * Runs the queued jobs of `queue` as the worker would, at `now` (its closes judged then), completes each, and dates
 * the runs they started at `now` (the schedule reads started_at: the test's clock, not the database's).
 */
async function drain(queue: "recon.tick" | "recon.daily", now: Date): Promise<string[]> {
  const b = await boss(), ran: string[] = [];
  for (;;) {
    const jobs = await b.fetch(queue, { batchSize: 10 });
    if (!jobs.length) break;
    for (const j of jobs) {
      const data = j.data as { spaceId: string; runId: string };
      await runScheduled(probe, data, undefined, () => now);
      await b.complete(queue, j.id);
      await db.update(reconRuns).set({ startedAt: now }).where(eq(reconRuns.id, data.runId));
      ran.push(data.runId);
    }
  }
  return ran;
}
const runOf = async (id: string) => (await db.select().from(reconRuns).where(eq(reconRuns.id, id)))[0]!;
const itemsOf = (configId: string) => db.select({ id: reconItems.id, breakPass: reconItems.breakPass, proposed: reconItems.proposedItemId, proposedPass: reconItems.proposedPass, side: reconItems.side, status: reconItems.status, reason: reconItems.breakReason, late: reconItems.lateMatch, resolution: reconItems.resolution, ref: records.extRef, date: reconItems.businessDate })
  .from(reconItems).innerJoin(records, and(eq(records.id, reconItems.recordId), eq(records.businessDate, reconItems.businessDate)))
  .where(and(eq(reconItems.configId, configId), sql`${reconItems.simRunId} is null`)).orderBy(asc(records.extRef), asc(reconItems.side));

beforeAll(async () => {
  probe = await appRoleDb();
  await resetData();
  await db.delete(spaces);
  await db.insert(calendars).values({ id: Bun.randomUUIDv7(), code: "id-default", name: "Default", weekend: [6, 7], holidays: [] }).onConflictDoNothing();
  await db.transaction((tx) => ensureMonthPartitions(tx, records, new Date(`${D}T00:00:00Z`), 2));
}, 60_000);
beforeEach(async () => {
  // the schedule reads every active space: the earlier tests' spaces are archived, each test has its own
  await db.update(spaces).set({ status: "archived" });
  A = Bun.randomUUIDv7();
  await db.insert(spaces).values({ id: A, code: `s${A.slice(-8)}`, name: "Treasury" });
  await (await boss()).deleteAllJobs();
});
afterAll(async () => {
  await probe.$client.close();
});

describe("the schedule", () => {
  it("interval: each tick takes only what is new; past grace an item breaks; a late counterpart closes the break (carry over 1)", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, interval(sa.sourceId, sb.sourceId));
    await put(sa, [{ ref: "K1", amount: 100n, et: `${D}T10:00:00+07:00` }, { ref: "K2", amount: 200n, et: `${D}T10:00:00+07:00` }]);
    await put(sb, [{ ref: "K1", amount: 100n, et: `${D}T10:00:00+07:00` }]);
    await complete(sa, at(`${D}T10:20:00`));
    await complete(sb, at(`${D}T10:20:00`));

    const first = await dispatch(db, at(`${D}T10:21:00`));
    expect(first.length).toBe(1);
    expect(await drain("recon.tick", at(`${D}T10:21:00`))).toEqual(first);
    const run1 = await runOf(first[0]!);
    expect([run1.mode, run1.status, run1.dateFrom, run1.dateTo]).toEqual(["tick", "succeeded", D, D]);
    expect((run1.counters as RunCounters).intake).toEqual({ a: 2, b: 1 });
    expect((await itemsOf(r.configId)).map((i) => [i.ref, i.side, i.status])).toEqual([["K1", "a", "matched"], ["K1", "b", "matched"], ["K2", "a", "open"]]);
    // a minute later: not due (every 2 minutes)
    expect(await dispatch(db, at(`${D}T10:22:00`))).toEqual([]);

    // side B delivered past K2's time + 30 minutes of grace, without K2: it breaks; K3 is new and waits
    await put(sb, [{ ref: "K3", amount: 300n, et: `${D}T10:25:00+07:00` }]);
    await complete(sb, at(`${D}T10:31:00`));
    const second = await dispatch(db, at(`${D}T10:24:00`));
    await drain("recon.tick", at(`${D}T10:24:00`));
    expect((((await runOf(second[0]!)).counters) as RunCounters).intake).toEqual({ a: 0, b: 1 });
    const k2 = (await itemsOf(r.configId)).find((i) => i.ref === "K2")!;
    expect([k2.status, k2.reason, k2.late]).toEqual(["break", "No counterpart", true]);
    expect((await itemsOf(r.configId)).find((i) => i.ref === "K3")!.status).toBe("open");

    // K2 arrives late on side B: the next tick pairs it with the break, closed as late data
    await put(sb, [{ ref: "K2", amount: 200n, et: `${D}T10:40:00+07:00` }]);
    const third = await dispatch(db, at(`${D}T10:27:00`));
    await drain("recon.tick", at(`${D}T10:27:00`));
    expect(((await runOf(third[0]!)).counters as RunCounters).passes["1"]!.matched).toBe(1);
    expect((await itemsOf(r.configId)).filter((i) => i.ref === "K2").map((i) => [i.side, i.status, i.resolution])).toEqual([
      ["a", "matched", "AUTO_MATCHED_LATE_DATA"], ["b", "matched", null],
    ]);
  }, 60_000);

  it("carry over 0 (KSEI) never pairs a closed day's break with the next day's data; carry over 7 does", async () => {
    const [sa, sb] = await sides();
    const k0 = await recon(A, spec(sa.sourceId, sb.sourceId, [exact], 0));
    const k7 = await recon(A, spec(sa.sourceId, sb.sourceId, [exact], 7));
    await put(sa, [{ ref: "K9", amount: 900n, date: D }]);
    const after = at("2026-12-31T00:00:00");
    for (const r of [k0, k7]) {
      await runRecon(probe, { ...r, mode: "daily", from: D });
      expect(await closeDay(probe, r, D, after)).toBe("closed");
      expect((await itemsOf(r.configId)).map((i) => [i.status, i.reason, i.late])).toEqual([["break", "No counterpart", true]]);
    }
    await put(sb, [{ ref: "K9", amount: 900n, date: D1 }]);
    for (const r of [k0, k7]) await runRecon(probe, { ...r, mode: "daily", from: D1 });
    expect((await itemsOf(k0.configId)).map((i) => [i.side, i.status])).toEqual([["a", "break"], ["b", "open"]]);
    expect((await itemsOf(k7.configId)).map((i) => [i.side, i.status, i.resolution])).toEqual([["a", "matched", "AUTO_MATCHED_LATE_DATA"], ["b", "matched", null]]);
  }, 60_000);

  it("carry over always (null): an unmatch 40 days old still pairs with late data; carry over 7 no longer checks it", async () => {
    const [sa, sb] = await sides();
    const kAll = await recon(A, spec(sa.sourceId, sb.sourceId, [exact], null as unknown as number));
    const k7 = await recon(A, spec(sa.sourceId, sb.sourceId, [exact], 7));
    const D40 = new Date(Date.parse(`${D}T00:00:00Z`) + 40 * 86_400_000).toISOString().slice(0, 10);
    await withSpace({ spaceIds: [A], userId: null }, (tx) => ensureMonthPartitions(tx, records, new Date(`${D40}T00:00:00Z`), 1));
    await put(sa, [{ ref: "K9", amount: 900n, date: D }]);
    const after = at("2026-12-31T00:00:00");
    for (const r of [kAll, k7]) { await runRecon(probe, { ...r, mode: "daily", from: D }); expect(await closeDay(probe, r, D, after)).toBe("closed"); }
    await put(sb, [{ ref: "K9", amount: 900n, date: D40 }]);
    for (const r of [kAll, k7]) await runRecon(probe, { ...r, mode: "daily", from: D40 });
    expect((await itemsOf(kAll.configId)).map((i) => [i.side, i.status, i.resolution])).toEqual([["a", "matched", "AUTO_MATCHED_LATE_DATA"], ["b", "matched", null]]);
    expect((await itemsOf(k7.configId)).map((i) => [i.side, i.status])).toEqual([["a", "break"], ["b", "open"]]);
  }, 60_000);

  it("always (null) still takes in late data dated before the oldest unmatch: a floor of 31 days (blind review I1)", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact], null as unknown as number));
    const D5 = new Date(Date.parse(`${D}T00:00:00Z`) - 5 * 86_400_000).toISOString().slice(0, 10);
    await withSpace({ spaceIds: [A], userId: null }, (tx) => ensureMonthPartitions(tx, records, new Date(`${D5}T00:00:00Z`), 2));
    await put(sa, [{ ref: "L5", amount: 500n, date: D5 }]);
    await put(sb, [{ ref: "L5", amount: 500n, date: D5 }]);
    const run = await runRecon(probe, { ...r, mode: "daily", from: D });
    expect((await itemsOf(r.configId)).map((i) => [i.side, i.status])).toEqual([["a", "matched"], ["b", "matched"]]);
    // the run keeps the carry it used, so its windows don't move as other unmatch closes later (blind review I3)
    expect(((await runOf(run.runId)).counters as { carry?: number }).carry).toBe(31);
  }, 60_000);

  it("always never changes a signed-off day: its late unmatch stays out of later passes (blind review I5)", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact], null as unknown as number));
    await put(sa, [{ ref: "S1", amount: 100n, date: D }]);
    const after = at("2026-12-31T00:00:00");
    await runRecon(probe, { ...r, mode: "daily", from: D });
    expect(await closeDay(probe, r, D, after)).toBe("closed");
    await withSpace({ spaceIds: [A], userId: null }, (tx) => tx.update(reconDays).set({ signedAt: new Date() }).where(and(eq(reconDays.configId, r.configId), eq(reconDays.businessDate, D))));
    await put(sb, [{ ref: "S1", amount: 100n, date: D1 }]);
    await runRecon(probe, { ...r, mode: "daily", from: D1 });
    expect((await itemsOf(r.configId)).map((i) => [i.side, i.status])).toEqual([["a", "break"], ["b", "open"]]);
  }, 60_000);

  it("catch-up: a daily recon whose worker was down fails the stale run, runs every date since the last closed one and closes each", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact], 1)); // daily at 23:30, offset 0, grace 30
    await db.insert(reconDays).values({ spaceId: A, configId: r.configId, businessDate: "2026-11-01", status: "closed", closedAt: new Date() });
    const stale = Bun.randomUUIDv7();
    await withSpace({ spaceIds: [A], userId: null }, (tx) => createRun(tx, { ...r, mode: "daily", from: "2026-11-02", status: "running", id: stale, jobId: Bun.randomUUIDv7() }), probe);
    await db.update(reconRuns).set({ startedAt: at("2026-11-02T23:30:00") }).where(eq(reconRuns.id, stale)); // the test's clock
    const dates = ["2026-11-02", "2026-11-03", "2026-11-04"];
    for (const [i, d] of dates.entries()) {
      await put(sa, [{ ref: `P${i}`, amount: 10n, date: d }, { ref: `Q${i}`, amount: 20n, date: d }]);
      await put(sb, [{ ref: `P${i}`, amount: 10n, date: d }]);
    }
    await complete(sa, at("2026-12-01T00:00:00"));
    await complete(sb, at("2026-12-01T00:00:00"));

    const now = at("2026-11-04T23:45:00");
    const started = await dispatch(db, now);
    expect(started.length).toBe(1);
    expect([(await runOf(stale)).status, (await runOf(stale)).error]).toEqual(["failed", RUN_STOPPED]);
    await drain("recon.daily", now);
    const run = await runOf(started[0]!);
    expect([run.mode, run.status, run.dateFrom, run.dateTo]).toEqual(["daily", "succeeded", "2026-11-02", "2026-11-04"]);
    const days = await db.select({ d: reconDays.businessDate, s: reconDays.status, incomplete: reconDays.incomplete, counters: reconDays.counters }).from(reconDays)
      .where(eq(reconDays.configId, r.configId)).orderBy(asc(reconDays.businessDate));
    expect(days.map((x) => [x.d, x.s])).toEqual([["2026-11-01", "closed"], ...dates.map((d) => [d, "closed"])]);
    expect(days.slice(1).map((x) => [x.incomplete, x.counters])).toEqual(dates.map(() => [null, { open: 1, suggested: 0 }]));
    expect((await itemsOf(r.configId)).filter((i) => i.status === "break").map((i) => i.ref)).toEqual(["Q0", "Q1", "Q2"]);
    // nothing left to do until the next date's run time
    expect(await dispatch(db, now)).toEqual([]);
    expect((await dispatch(db, at("2026-11-05T23:30:00"))).length).toBe(1);
  }, 60_000);

  it("a manual run closes its dates past close as a scheduled one does, and stops at a date still waiting for data (Captain)", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact], 1)); // closes at 23:30, grace 30
    await put(sa, [{ ref: "P", amount: 10n, date: D }, { ref: "Q", amount: 20n, date: D }, { ref: "R", amount: 30n, date: D }, { ref: "S", amount: 40n, date: D1 }]);
    await put(sb, [{ ref: "P", amount: 10n, date: D }, { ref: "R", amount: 31n, date: D }]);
    await complete(sa, at("2026-12-01T00:00:00"));
    await complete(sb, at(`${D1}T12:00:00`)); // the 2nd complete; the 3rd not yet
    const id = Bun.randomUUIDv7();
    await withSpace({ spaceIds: [A], userId: null }, (tx) => createRun(tx, { ...r, mode: "manual", from: D, to: D1, status: "queued", id, jobId: id }), probe);
    await runScheduled(probe, { spaceId: A, runId: id }, undefined, () => at(`${D1}T23:45:00`)); // past the 3rd's close, within its grace
    expect((await runOf(id)).status).toBe("succeeded");
    const days = await db.select({ d: reconDays.businessDate, s: reconDays.status }).from(reconDays).where(eq(reconDays.configId, r.configId)).orderBy(asc(reconDays.businessDate));
    expect(days.map((x) => [x.d, x.s])).toEqual([[D, "closed"], [D1, "closing"]]);
    expect((await itemsOf(r.configId)).map((i) => [i.ref, i.side, i.status, i.reason])).toEqual([
      ["P", "a", "matched", null], ["P", "b", "matched", null], ["Q", "a", "break", "No counterpart"],
      ["R", "a", "break", "Amount differs"], ["R", "b", "break", "Amount differs"], ["S", "a", "open", null],
    ]);
  }, 60_000);

  it("a day whose data isn't complete waits until close + grace, then closes marked incomplete", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact], 1)); // closes right after its 23:30 run, grace 30
    await put(sa, [{ ref: "Z1", amount: 10n, date: D }]);
    await complete(sa, at("2026-12-01T00:00:00"));
    await complete(sb, at(`${D}T12:00:00`));
    await runRecon(probe, { ...r, mode: "daily", from: D });
    expect(await closeDay(probe, r, D, at(`${D}T23:00:00`))).toBe("not_due");
    expect(await closeDay(probe, r, D, at(`${D}T23:45:00`))).toBe("closing");
    const day = () => db.select().from(reconDays).where(eq(reconDays.configId, r.configId));
    expect((await day()).map((x) => x.status)).toEqual(["closing"]);
    expect((await itemsOf(r.configId))[0]!.status).toBe("open");
    expect(await closeDay(probe, r, D, at(`${D1}T00:00:00`))).toBe("closed");
    expect((await day())[0]!.incomplete).toEqual([{ side: "b", sourceId: sb.sourceId, completeThrough: at(`${D}T12:00:00`).toISOString() }]);
    expect((await itemsOf(r.configId))[0]!.status).toBe("break");
  }, 60_000);
});

describe("day close, review round 1", () => {
  const tolerance = { no: 2, name: "Tolerance", cardinality: "1:1", blocking: ["ext_ref"], accept: "suggest", on_ambiguous: "suggest",
    predicates: [{ op: "amount_abs_tol", field: "amount_minor", tolerance: { IDR: "1000.00" } }, ccyEq] };

  it("C-1: records that arrive after a run's intake are never closed away (carry over 0); the schedule reruns once the source moved, not before", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact], 0)); // daily at 23:30, offset 0, grace 30
    await complete(sa, at(`${D}T12:00:00`));
    await complete(sb, at(`${D}T12:00:00`));
    await put(sa, [{ ref: "X1", amount: 10n, date: D }]);
    await put(sb, [{ ref: "X1", amount: 10n, date: D }]);
    const now = at(`${D}T23:40:00`);
    const first = await dispatch(db, now);
    await drain("recon.daily", now); // its close waits: the intake saw both sides complete only through 12:00
    expect((await db.select({ s: reconDays.status }).from(reconDays).where(eq(reconDays.configId, r.configId))).map((x) => x.s)).toEqual(["closing"]);
    expect((await runOf(first[0]!)).seen).toEqual({ [D]: { a: at(`${D}T12:00:00`).toISOString(), b: at(`${D}T12:00:00`).toISOString() } });
    // nothing moved: no new run before close + grace; nor when a cursor moves within the date (a pull each minute)
    expect(await dispatch(db, at(`${D}T23:41:00`))).toEqual([]);
    await complete(sb, at(`${D}T18:00:00`));
    expect(await dispatch(db, at(`${D}T23:41:30`))).toEqual([]);
    // a pull commits more of D and the cursor past D's end, after that intake: a close on the cursor now would lose X2
    await put(sa, [{ ref: "X2", amount: 20n, date: D }]);
    await complete(sa, at(`${D1}T01:00:00`));
    await complete(sb, at(`${D1}T01:00:00`));
    expect(await closeDay(probe, r, D, at(`${D}T23:42:00`))).toBe("closing");
    const second = await dispatch(db, at(`${D}T23:42:00`));
    expect(second.length).toBe(1);
    await drain("recon.daily", at(`${D}T23:42:00`));
    const day = (await db.select().from(reconDays).where(eq(reconDays.configId, r.configId)))[0]!;
    expect([day.status, day.incomplete]).toEqual(["closed", null]);
    expect((await itemsOf(r.configId)).map((i) => [i.ref, i.side, i.status, i.reason])).toEqual([
      ["X1", "a", "matched", null], ["X1", "b", "matched", null], ["X2", "a", "break", "No counterpart"],
    ]);
  }, 60_000);

  it("C-1: a date waits while a run of the recon is queued or running", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact], 0));
    await complete(sa, at("2026-12-01T00:00:00"));
    await complete(sb, at("2026-12-01T00:00:00"));
    await runRecon(probe, { ...r, mode: "daily", from: D });
    await withSpace({ spaceIds: [A], userId: null }, (tx) => createRun(tx, { ...r, mode: "daily", from: D, status: "queued" }), probe);
    expect(await closeDay(probe, r, D, at("2026-12-01T00:00:00"))).toBe("closing");
    await db.update(reconRuns).set({ status: "failed" }).where(eq(reconRuns.status, "queued"));
    expect(await closeDay(probe, r, D, at("2026-12-01T00:00:00"))).toBe("closed");
  }, 60_000);

  it("I-1: a recon whose last scheduled run failed waits 15 minutes before the next", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact], 0));
    const id = await withSpace({ spaceIds: [A], userId: null }, (tx) => createRun(tx, { ...r, mode: "daily", from: D, status: "running" }), probe);
    await db.update(reconRuns).set({ status: "failed", startedAt: at(`${D}T23:30:00`) }).where(eq(reconRuns.id, id));
    expect(await dispatch(db, at(`${D}T23:40:00`))).toEqual([]);
    expect((await dispatch(db, at(`${D}T23:45:00`))).length).toBe(1);
  }, 60_000);

  it("I-2: a pair across two dates gets the same reasons in a simulation's projection as in the live closes", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact], 1));
    await put(sa, [{ ref: "P1", amount: 100n, date: D }]);
    await put(sb, [{ ref: "P1", amount: 200n, date: D1 }]);
    await complete(sa, at("2026-12-01T00:00:00"));
    await complete(sb, at("2026-12-01T00:00:00"));
    const after = at("2026-12-01T00:00:00");
    for (const d of [D, D1]) {
      await runRecon(probe, { ...r, mode: "daily", from: d });
      expect(await closeDay(probe, r, d, after)).toBe("closed");
    }
    const live = (await itemsOf(r.configId)).map((i) => [i.side, i.date, i.reason ?? ""]);
    expect(live).toEqual([["a", D, "No counterpart"], ["b", D1, "Amount differs"]]);
    const draft = Bun.randomUUIDv7();
    await db.insert(reconConfigVersions).values({ id: draft, configId: r.configId, spaceId: A, version: 2, status: "draft", spec: spec(sa.sourceId, sb.sourceId, [exact], 1), specHash: "h2", matchingHash: "h2", makerId: U });
    const sim = await runRecon(probe, { ...r, versionId: draft, mode: "simulation", from: D, to: D1 });
    const projected = await withSpace({ spaceIds: [A], userId: null }, (tx) => classifyUnmatched(tx, { ...r, versionId: draft, simRunId: sim.runId, from: D, to: D1 }), probe);
    expect(projected.map((x) => [x.side, x.businessDate, x.reason])).toEqual(live);
  }, 60_000);

  it("DEC-047 (carry over 1, two dates): an exact pass closes a No counterpart break as late data; a suggest pass leaves it a break with the pair proposed; Duplicate and Currency differs breaks stay out", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact, tolerance], 1));
    await put(sa, [{ ref: "E1", amount: 100n, date: D }, { ref: "S1", amount: 100n, date: D }, { ref: "DU", amount: 50n, date: D }, { ref: "DU", amount: 50n, date: D },
      { ref: "CU", amount: 70n, date: D }, { ref: "AD", amount: 100n, date: D }]);
    // AD: outside pass 2's tolerance (1,000.00) on D, a near miss "Amount differs"
    await put(sb, [{ ref: "DU", amount: 50n, date: D }, { ref: "CU", amount: 70n, ccy: "USD", date: D }, { ref: "AD", amount: 200_100n, date: D }]);
    await complete(sa, at("2026-12-01T00:00:00"));
    await complete(sb, at("2026-12-01T00:00:00"));
    await runRecon(probe, { ...r, mode: "daily", from: D });
    expect(await closeDay(probe, r, D, at("2026-12-01T00:00:00"))).toBe("closed");
    const kept = (ref: string | null) => ref === "DU" || ref === "CU" || ref === "AD";
    const before = (await itemsOf(r.configId)).filter((i) => kept(i.ref));
    expect(before.map((i) => [i.ref, i.side, i.reason, i.late])).toEqual([
      ["AD", "a", "Amount differs", false], ["AD", "b", "Amount differs", false],
      ["CU", "a", "Currency differs", false], ["CU", "b", "Currency differs", false],
      ["DU", "a", "Duplicate", false], ["DU", "a", "Duplicate", false], ["DU", "b", "Duplicate", false],
    ]);
    // D1: counterparts for all of them: E1 exact, S1 within tolerance, a second DU on B (2:2), CU in IDR, AD within tolerance
    await put(sb, [{ ref: "E1", amount: 100n, date: D1 }, { ref: "S1", amount: 150n, date: D1 }, { ref: "DU", amount: 50n, date: D1 }, { ref: "CU", amount: 70n, date: D1 },
      { ref: "AD", amount: 150n, date: D1 }]);
    await runRecon(probe, { ...r, mode: "daily", from: D1 });
    const items = await itemsOf(r.configId);
    const s1bItem = items.find((i) => i.ref === "S1" && i.side === "b")!;
    expect(items.filter((i) => i.ref === "E1" || i.ref === "S1").map((i) => [i.ref, i.side, i.status, i.resolution, i.proposedPass])).toEqual([
      ["E1", "a", "matched", "AUTO_MATCHED_LATE_DATA", null], ["E1", "b", "matched", null, null],
      ["S1", "a", "break", null, 2], ["S1", "b", "open", null, null],
    ]);
    // the Duplicate, Currency differs and Amount differs breaks are untouched: no match, no proposal; D1's new items wait
    const old = items.filter((i) => kept(i.ref) && i.date === D);
    expect(old.map((i) => [i.ref, i.side, i.status, i.reason, i.resolution, i.proposed])).toEqual(before.map((i) => [i.ref, i.side, "break", i.reason, null, null]));
    expect(items.filter((i) => kept(i.ref) && i.date === D1).map((i) => [i.ref, i.side, i.status])).toEqual([["AD", "b", "open"], ["CU", "b", "open"], ["DU", "b", "open"]]);
    // the proposed item gets paired elsewhere (an exact A on D1): the next run clears the stale proposal
    await put(sa, [{ ref: "S1", amount: 150n, date: D1 }]);
    await runRecon(probe, { ...r, mode: "daily", from: D1 });
    const s1 = (await itemsOf(r.configId)).filter((i) => i.ref === "S1").sort((x, y) => (x.side + x.date).localeCompare(y.side + y.date));
    expect(s1.map((i) => [i.side, i.date, i.status, i.proposed, i.proposedPass])).toEqual([["a", D, "break", null, null], ["a", D1, "matched", null, null], ["b", D1, "matched", null, null]]);
    expect(items.find((i) => i.ref === "S1" && i.side === "a")!.proposed).toBe(s1bItem.id);
  }, 60_000);

  it("two closes of one date at once: one closes it, the other finds it closed; counters once", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact], 0));
    await put(sa, [{ ref: "R1", amount: 10n, date: D }]);
    await complete(sa, at("2026-12-01T00:00:00"));
    await complete(sb, at("2026-12-01T00:00:00"));
    await runRecon(probe, { ...r, mode: "daily", from: D });
    const after = at("2026-12-01T00:00:00");
    expect((await Promise.all([closeDay(probe, r, D, after), closeDay(probe, r, D, after)])).sort()).toEqual(["already", "closed"]);
    expect((await db.select({ c: reconDays.counters }).from(reconDays).where(eq(reconDays.configId, r.configId)))[0]!.c).toEqual({ open: 1, suggested: 0 });
  }, 60_000);

  it("M-6: an item an operator holds at close stays open, and the next sweep breaks it", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact], 0));
    await put(sa, [{ ref: "H1", amount: 10n, date: D }, { ref: "H2", amount: 20n, date: D }]);
    await complete(sa, at("2026-12-01T00:00:00"));
    await complete(sb, at("2026-12-01T00:00:00"));
    await runRecon(probe, { ...r, mode: "daily", from: D });
    const h1 = (await itemsOf(r.configId)).find((i) => i.ref === "H1")!;
    const hold = await holdTx((tx) => tx.select({ id: reconItems.id }).from(reconItems).where(eq(reconItems.id, h1.id)).for("update"));
    expect(await closeDay(probe, r, D, at("2026-12-01T00:00:00"))).toBe("closed");
    await hold.rollback();
    expect((await itemsOf(r.configId)).map((i) => [i.ref, i.status])).toEqual([["H1", "open"], ["H2", "break"]]);
    // not while a run of the recon is under way (its intake may have added items its passes haven't seen yet)
    const queued = await withSpace({ spaceIds: [A], userId: null }, (tx) => createRun(tx, { ...r, mode: "daily", from: D1, status: "queued" }), probe);
    expect(await sweepClosed(probe, r, D, D)).toEqual({ open: 0, suggested: 0, dates: [] });
    await db.update(reconRuns).set({ status: "failed" }).where(eq(reconRuns.id, queued));
    expect(await sweepClosed(probe, r, D, D)).toEqual({ open: 1, suggested: 0, dates: [D] });
    expect((await itemsOf(r.configId)).map((i) => [i.ref, i.status, i.reason])).toEqual([["H1", "break", "No counterpart"], ["H2", "break", "No counterpart"]]);
    // REC-FUT-17: the date's counters count its items made breaks, the close's and the sweep's, as a recount does
    const breaks = (await itemsOf(r.configId)).filter((i) => i.status === "break").length;
    expect((await db.select({ c: reconDays.counters }).from(reconDays).where(eq(reconDays.configId, r.configId)))[0]!.c).toEqual({ open: breaks, suggested: 0 });
    // and the run that covered the date shows the sweep's break too (Today, Live day and the trend read its days)
    const [run] = await db.select({ id: reconRuns.id }).from(reconRuns).where(and(eq(reconRuns.configId, r.configId), eq(reconRuns.status, "succeeded"))).orderBy(desc(reconRuns.finishedAt)).limit(1);
    await refreshCovering(probe, r, [D]);
    const [after] = await db.select({ days: reconRuns.days }).from(reconRuns).where(eq(reconRuns.id, run!.id));
    expect((after!.days as { date: string; breaks: { a: number; b: number } }[]).find((x) => x.date === D)!.breaks).toEqual({ a: breaks, b: 0 });
  }, 60_000);

  it("unconfirmed suggestions at close: a unique one is an Unconfirmed suggestion; a tie is a Duplicate with its pass", async () => {
    const [sa, sb] = await sides();
    const suggest = { no: 1, name: "Reference", cardinality: "1:1", blocking: [], accept: "suggest", on_ambiguous: "suggest", predicates: [{ op: "eq", field: "ext_ref" }, ccyEq] };
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [suggest], 0));
    await put(sa, [{ ref: "U1", amount: 10n, date: D }, { ref: "T1", amount: 10n, date: D }]);
    await put(sb, [{ ref: "U1", amount: 10n, date: D }, { ref: "T1", amount: 10n, date: D }, { ref: "T1", amount: 10n, date: D }]);
    await complete(sa, at("2026-12-01T00:00:00"));
    await complete(sb, at("2026-12-01T00:00:00"));
    await runRecon(probe, { ...r, mode: "daily", from: D });
    expect(await closeDay(probe, r, D, at("2026-12-01T00:00:00"))).toBe("closed");
    // the two side-B T1 rows are alike: which one the tie keeps follows their ids, so compare them in a fixed order
    const key = (x: unknown[]) => x.map(String).join("|");
    expect((await itemsOf(r.configId)).map((i) => [i.ref, i.side, i.status, i.reason, i.breakPass]).sort((x, y) => key(x).localeCompare(key(y)))).toEqual([
      ["T1", "a", "break", "Duplicate", 1], ["T1", "b", "break", "Duplicate", 1], ["T1", "b", "break", "No counterpart", null],
      ["U1", "a", "break", "Unconfirmed suggestion", null], ["U1", "b", "break", "Unconfirmed suggestion", null],
    ]);
  }, 60_000);
});

describe("run details", () => {
  it("intake per chunk takes every record once (5 and 4 records, chunks of 2)", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact], 1));
    await put(sa, [1, 2, 3, 4, 5].map((k) => ({ ref: `C${k}`, amount: BigInt(k) })));
    await put(sb, [1, 2, 3, 4].map((k) => ({ ref: `C${k}`, amount: BigInt(k) })));
    const id = await withSpace({ spaceIds: [A], userId: null }, (tx) => createRun(tx, { ...r, mode: "manual", from: D, status: "running" }), probe);
    const out = await execRun(probe, A, id, { chunk: 2 });
    expect(out!.counters.intake).toEqual({ a: 5, b: 4 });
    expect(out!.counters.passes["1"]!.matched).toBe(4);
    expect((await runOf(id)).intakeDone).toBe(`${D}:b`);
  }, 60_000);

  it("a live intake reads past its mark: the next run takes what arrived since; a new version reads the date from the start", async () => {
    const [sa, sb] = await sides();
    const base = spec(sa.sourceId, sb.sourceId, [exact], 0);
    // version 1 leaves M3 of side A out
    const r = await recon(A, { ...base, sides: [{ ...base.sides[0], filter: [{ field: "ext_ref", op: "ne", value: "M3" }] }, base.sides[1]] });
    await put(sa, [1, 2, 3].map((k) => ({ ref: `M${k}`, amount: BigInt(k) })));
    await put(sb, [1, 2, 3].map((k) => ({ ref: `M${k}`, amount: BigInt(k) })));
    const run = (versionId: string) => runRecon(probe, { spaceId: A, configId: r.configId, versionId, mode: "manual", from: D });
    expect((await run(r.versionId)).counters.intake).toEqual({ a: 2, b: 3 });
    await put(sa, [{ ref: "M4", amount: 4n }]);
    await put(sb, [{ ref: "M4", amount: 4n }]);
    const second = await run(r.versionId);
    expect([second.counters.intake, second.counters.passes["1"]!.matched]).toEqual([{ a: 1, b: 1 }, 1]);
    // version 2 without the filter: M3, below version 1's mark, is taken in now
    const v2 = Bun.randomUUIDv7();
    await db.update(reconConfigVersions).set({ status: "retired" }).where(eq(reconConfigVersions.id, r.versionId));
    await db.insert(reconConfigVersions).values({ id: v2, configId: r.configId, spaceId: A, version: 2, status: "published", specHash: "v2", matchingHash: "v2", makerId: r.configId, spec: base });
    const third = await run(v2);
    expect([third.counters.intake, third.counters.passes["1"]!.matched]).toEqual([{ a: 1, b: 0 }, 1]);
  }, 60_000);

  it("a manual run without dates takes the day after the last closed one within 30 days, else today; a closed date is refused", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact], 1));
    const op = (await db.select({ id: users.id }).from(users).where(eq(users.username, "apple")))[0]!.id;
    await db.insert(spaceMembers).values({ spaceId: A, userId: op, role: "operator" });
    const token = await signIn("apple");
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
    const first = await call("POST", `/v1/spaces/${A}/recons/${r.configId}/runs`, { token, body: {} });
    expect(first.status).toBe(202);
    const dto = (await first.json()) as ReconRunDto;
    expect([dto.from, dto.to]).toEqual([today, today]);
    // that run over (its job too), so the next request may start one
    await db.update(reconRuns).set({ status: "succeeded" }).where(eq(reconRuns.id, dto.id));
    await (await boss()).deleteAllJobs();
    const closed = new Date(Date.parse(`${today}T00:00:00Z`) - 3 * 86_400_000).toISOString().slice(0, 10);
    await db.insert(reconDays).values({ spaceId: A, configId: r.configId, businessDate: closed, status: "closed" });
    const after = new Date(Date.parse(`${closed}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const refused = await call("POST", `/v1/spaces/${A}/recons/${r.configId}/runs`, { token, body: { from: closed, to: after } });
    expect([refused.status, ((await refused.json()) as { error: { message: string } }).error.message]).toEqual([409, CLOSED_DAY]);
    const second = (await (await call("POST", `/v1/spaces/${A}/recons/${r.configId}/runs`, { token, body: {} })).json()) as ReconRunDto;
    expect([second.from, second.to]).toEqual([after, after]);
  }, 60_000);

  it("source health is judged on the stricter of the source's inputs and its recons' (grace, daily deadline)", async () => {
    const [sa] = await sides();
    const r = await recon(A, spec(sa.sourceId, sa.sourceId, [exact], 1));
    const list = [{ id: sa.sourceId, spaceId: A, kind: "file_inbox" as const, status: "active" as const, spec: plainSource() }];
    const now = at("2026-11-03T10:00:00"); // the 2nd's file is due; none came
    const judge = () => withSpace({ spaceIds: [A], userId: null }, async (tx) => (await sourceStates(tx, list, A, now, await reconHealthInputs(tx, [sa.sourceId]))).get(sa.sourceId)!.health!, probe);
    expect((await judge()).state).toBe("degraded"); // no deadline anywhere
    await db.insert(reconSourceUses).values({ spaceId: A, configId: r.configId, sourceSpaceId: A, sourceId: sa.sourceId, field: "ext_ref", configName: "R", graceMinutes: 30, deadline: "09:00" });
    const h = await judge();
    expect([h.state, h.deadline, h.graceMinutes]).toEqual(["down", "09:00", 30]);
  }, 60_000);
});

describe("Today and Live day (REC-F4)", () => {
  /** The schedule's runs finished at the test's clock (finished_at is the database's now otherwise). */
  const finishedAt = (ids: string[], t: Date) => db.update(reconRuns).set({ finishedAt: t }).where(inArray(reconRuns.id, ids));

  it("the day as the last live run left it, open breaks, freshness from the last scheduled success; sources by name", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, interval(sa.sourceId, sb.sourceId));
    const ctx = { space: { id: A, roles: [] }, user: { id: U } } as unknown as Ctx;
    await put(sa, [{ ref: "K1", amount: 100n, et: `${D}T10:00:00+07:00` }, { ref: "K2", amount: 200n, et: `${D}T10:00:00+07:00` }]);
    await put(sb, [{ ref: "K1", amount: 100n, et: `${D}T10:00:00+07:00` }]);
    await complete(sa, at(`${D}T10:20:00`));
    await complete(sb, at(`${D}T10:20:00`));
    // before any run: an open day without numbers, not stale yet (published today, 2 minutes)
    const none = (await todayDto(ctx, at(`${D}T00:01:00`))).recons[0]!;
    expect([none.date, none.state, none.day, none.runId, none.openBreaks, none.lastSuccessAt]).toEqual([D, "open", null, null, 0, null]);

    const first = await dispatch(db, at(`${D}T10:21:00`));
    await drain("recon.tick", at(`${D}T10:21:00`));
    await finishedAt(first, at(`${D}T10:21:30`));
    const t1 = await todayDto(ctx, at(`${D}T10:22:00`));
    const x = t1.recons[0]!;
    expect([x.id, x.date, x.state, x.runId, x.stale, x.openBreaks, x.running]).toEqual([r.configId, D, "open", first[0]!, false, 0, null]);
    expect([x.day!.passes["1"]!.matched, x.day!.open]).toEqual([1, { a: 1, b: 0 }]);
    expect(t1.sources.map((s) => s.id).sort()).toEqual([sa.sourceId, sb.sourceId].sort());
    expect(t1.capped).toBe(false);

    // side B complete past K2 + grace without it: K2 breaks; the next run's day says so
    await complete(sb, at(`${D}T10:31:00`));
    const second = await dispatch(db, at(`${D}T10:24:00`));
    await drain("recon.tick", at(`${D}T10:24:00`));
    await finishedAt(second, at(`${D}T10:24:30`));
    const x2 = (await reconLive(ctx, r.configId, at(`${D}T10:25:00`))).recon;
    expect([x2.runId, x2.openBreaks, x2.day!.breaks]).toEqual([second[0]!, 1, { a: 1, b: 0 }]);
    // no run since 10:24:30: stale past twice its 2 minutes (and not once the day is closed)
    expect((await reconLive(ctx, r.configId, at(`${D}T10:28:31`))).recon.stale).toBe(true);
    await db.insert(reconDays).values({ spaceId: A, configId: r.configId, businessDate: D, status: "closed" });
    const closed = (await reconLive(ctx, r.configId, at(`${D}T10:28:31`))).recon;
    expect([closed.state, closed.stale]).toEqual(["closed", false]);
    // the trend: 14 dates up to its current one, the last run's day on D, nothing before any run
    const trend = await reconTrend(ctx, r.configId, at(`${D}T10:28:31`));
    expect(trend.days).toHaveLength(14);
    expect(trend.days.at(-1)!.date).toBe(D);
    expect(trend.days.at(-1)!.day!.breaks).toEqual({ a: 1, b: 0 });
    expect(trend.days.slice(0, -1).every((d) => d.day === null)).toBe(true);
  }, 60_000);

  it("a stale spell alerts once, however many dispatches at once; again an hour later or after a new success", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, interval(sa.sourceId, sb.sourceId));
    const since = at(`${D}T10:00:00`), now = at(`${D}T10:10:00`);
    const once = await Promise.all(Array.from({ length: 5 }, () => alertStale(probe, A, r.configId, since, now)));
    expect(once.filter(Boolean).length).toBe(1);
    expect(await alertStale(probe, A, r.configId, since, at(`${D}T10:59:59`))).toBe(false);
    expect(await alertStale(probe, A, r.configId, since, at(`${D}T11:10:00`))).toBe(true);
    // a success after the last alert, then stale again: a new spell
    expect(await alertStale(probe, A, r.configId, at(`${D}T11:20:00`), at(`${D}T11:30:00`))).toBe(true);
  }, 60_000);

  it("routes: a member reads; another space's recon is 404; a recon without an approved version is 409", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, interval(sa.sourceId, sb.sourceId));
    const draft = await recon(A, interval(sa.sourceId, sb.sourceId), "draft");
    const viewer = (await db.select({ id: users.id }).from(users).where(eq(users.username, "viewer")))[0]!.id;
    await db.insert(spaceMembers).values({ spaceId: A, userId: viewer, role: "viewer" });
    const token = await signIn("viewer");
    expect((await call("GET", `/v1/spaces/${A}/today`)).status).toBe(401);
    const today = await call("GET", `/v1/spaces/${A}/today`, { token });
    expect(today.status).toBe(200);
    expect(((await today.json()) as TodayDto).recons.map((x) => x.id)).toEqual([r.configId]);
    expect((await call("GET", `/v1/spaces/${A}/recons/${r.configId}/live`, { token })).status).toBe(200);
    expect((await call("GET", `/v1/spaces/${A}/recons/${draft.configId}/live`, { token })).status).toBe(409);
    expect((await call("GET", `/v1/spaces/${A}/recons/${r.configId}/days`, { token })).status).toBe(200);
    expect((await call("GET", `/v1/spaces/${A}/recons/${draft.configId}/days`, { token })).status).toBe(409);
    expect((await call("GET", `/v1/spaces/${A}/recons/${Bun.randomUUIDv7()}/live`, { token })).status).toBe(404);
    const B = Bun.randomUUIDv7();
    await db.insert(spaces).values({ id: B, code: `s${B.slice(-8)}`, name: "Other" });
    await db.insert(spaceMembers).values({ spaceId: B, userId: viewer, role: "viewer" });
    expect((await call("GET", `/v1/spaces/${B}/recons/${r.configId}/live`, { token })).status).toBe(404);
    expect(((await (await call("GET", `/v1/spaces/${B}/today`, { token })).json()) as TodayDto).recons).toEqual([]);
  }, 60_000);
});
