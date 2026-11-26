// The schedule and carry over without a day close (DEC-064): the minute's dispatch (on the test's own pool: it writes
// pg-boss jobs, which the test database's app role may not) and the tick / daily jobs as the app role (appRoleDb, as the
// worker's workerDb), run by hand at a chosen `now`, on records written directly.
// - a recon runs its current date once per slot of its window; outside the window nothing starts;
// - each run takes only what is new and makes what stays unpaired unmatch at once; a late counterpart within carry over
//   closes that unmatch as AUTO_MATCHED_LATE_DATA, whatever its reason; carry over 0 never meets the next day's data;
// - a signed-off date is frozen: its unmatch stays out of later passes, and a manual run over it is refused;
// - intake per chunk; the default range of a manual run (the schedule's current date); sourceHealth's inputs from the recons.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { ReconRunDto, TodayDto } from "@starterkit/shared/contracts/recon";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { appRoleDb } from "../../../../../test/helpers/app-role";
import { db } from "../../../../kernel/db";
import { boss } from "../../../../kernel/jobs";
import { ensureMonthPartitions } from "../../../../kernel/partitions";
import { records, sourceStates } from "../../../ingest";
import { reconHealthInputs, reconSourceUses } from "../../../recon";
import { calendars } from "../../../sources";
import { spaceMembers, spaces, withSpace } from "../../../spaces";
import { users } from "../../../users";
import { reconConfigVersions } from "../../../recon";
import { SIGNED_DAY } from "../../jobs";
import { alertStale, dispatch, runScheduled } from "../../schedule";
import { reconLive, reconTrend, todayDto } from "../../today";
import type { Ctx } from "../../../auth";
import { reconDays, reconItems, reconRuns } from "../../schema";
import { createRun, execRun, runRecon, type RunCounters } from "../../service";
import { ccyEq, D, D1, makeSource, plainSource, put, recon, spec, type Src, U } from "../fixtures";

type Probe = Awaited<ReturnType<typeof appRoleDb>>;
let probe: Probe, A: string;

const at = (s: string) => new Date(`${s}+07:00`);
const exact = { no: 1, name: "Exact", cardinality: "1:1", blocking: [], accept: "auto", on_ambiguous: "break", predicates: [{ op: "eq", field: "ext_ref" }, { op: "eq", field: "amount_minor" }, ccyEq] };
const sides = async () => [await makeSource(A, plainSource()), await makeSource(A, plainSource())] as [Src, Src];
/** Today's date all day, every 2 minutes (a real-time recon). */
const interval = (a: string, b: string, carry = 1) => ({ ...spec(a, b, [exact], carry), schedule: { business_date_offset: 0, from: "00:00", to: "23:59", every_minutes: 2 } });
/** Date D on D + 1 from 07:00 to 16:00, every 60 minutes (data that lands the next day). */
const window = (a: string, b: string, carry = 1) => ({ ...spec(a, b, [exact], carry), schedule: { business_date_offset: 1, from: "07:00", to: "16:00", every_minutes: 60 } });

/**
 * Runs the queued jobs of `queue` as the worker would, completes each, and dates the runs they started at `now` (the
 * schedule reads started_at: the test's clock, not the database's).
 */
async function drain(queue: "recon.tick" | "recon.daily", now: Date): Promise<string[]> {
  const b = await boss(), ran: string[] = [];
  for (;;) {
    const jobs = await b.fetch(queue, { batchSize: 10 });
    if (!jobs.length) break;
    for (const j of jobs) {
      const data = j.data as { spaceId: string; runId: string };
      await runScheduled(probe, data);
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
  it("a window's ticks take only what is new; what stays unpaired is unmatch at once; a late counterpart closes it as late data (carry over 1)", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, interval(sa.sourceId, sb.sourceId));
    await put(sa, [{ ref: "K1", amount: 100n }, { ref: "K2", amount: 200n }]);
    await put(sb, [{ ref: "K1", amount: 100n }]);

    const first = await dispatch(db, at(`${D}T10:21:00`));
    expect(first.length).toBe(1);
    expect(await drain("recon.tick", at(`${D}T10:21:00`))).toEqual(first);
    const run1 = await runOf(first[0]!);
    expect([run1.mode, run1.status, run1.dateFrom, run1.dateTo]).toEqual(["tick", "succeeded", D, D]);
    expect((run1.counters as RunCounters).intake).toEqual({ a: 2, b: 1 });
    // no day close and no grace: K2 is unmatch now (DEC-064)
    expect((await itemsOf(r.configId)).map((i) => [i.ref, i.side, i.status, i.reason])).toEqual([["K1", "a", "matched", null], ["K1", "b", "matched", null], ["K2", "a", "break", "No counterpart"]]);
    // later in the same slot (every 2 minutes from 00:00): not due
    expect(await dispatch(db, at(`${D}T10:21:50`))).toEqual([]);

    // K2 arrives late on side B: the next slot's tick pairs it with the unmatch, closed as late data
    await put(sb, [{ ref: "K2", amount: 200n }]);
    const second = await dispatch(db, at(`${D}T10:22:00`));
    await drain("recon.tick", at(`${D}T10:22:00`));
    expect((((await runOf(second[0]!)).counters) as RunCounters).intake).toEqual({ a: 0, b: 1 });
    expect((await itemsOf(r.configId)).filter((i) => i.ref === "K2").map((i) => [i.side, i.status, i.resolution])).toEqual([
      ["a", "matched", "AUTO_MATCHED_LATE_DATA"], ["b", "matched", null],
    ]);
  }, 60_000);

  it("a window: date D runs on D + offset, once per slot from `from` to `to`; nothing outside it", async () => {
    const [sa, sb] = await sides();
    await recon(A, window(sa.sourceId, sb.sourceId));
    expect(await dispatch(db, at(`${D1}T06:59:00`))).toEqual([]);
    const first = await dispatch(db, at(`${D1}T07:00:00`));
    expect(first.length).toBe(1);
    const run = await runOf(first[0]!);
    expect([run.mode, run.dateFrom, run.dateTo]).toEqual(["tick", D, D]);
    await drain("recon.tick", at(`${D1}T07:00:00`));
    expect(await dispatch(db, at(`${D1}T07:59:00`))).toEqual([]);
    expect((await dispatch(db, at(`${D1}T08:00:00`))).length).toBe(1);
    await drain("recon.tick", at(`${D1}T16:00:00`));
    expect(await dispatch(db, at(`${D1}T16:30:00`))).toEqual([]);
  }, 60_000);

  it("carry over 0 (KSEI) never pairs an earlier date's unmatch with the next day's data; carry over 7 does", async () => {
    const [sa, sb] = await sides();
    const k0 = await recon(A, spec(sa.sourceId, sb.sourceId, [exact], 0));
    const k7 = await recon(A, spec(sa.sourceId, sb.sourceId, [exact], 7));
    await put(sa, [{ ref: "K9", amount: 900n, date: D }]);
    for (const r of [k0, k7]) {
      await runRecon(probe, { ...r, mode: "daily", from: D });
      expect((await itemsOf(r.configId)).map((i) => [i.status, i.reason, i.late])).toEqual([["break", "No counterpart", true]]);
    }
    await put(sb, [{ ref: "K9", amount: 900n, date: D1 }]);
    for (const r of [k0, k7]) await runRecon(probe, { ...r, mode: "daily", from: D1 });
    expect((await itemsOf(k0.configId)).map((i) => [i.side, i.status])).toEqual([["a", "break"], ["b", "break"]]);
    expect((await itemsOf(k7.configId)).map((i) => [i.side, i.status, i.resolution])).toEqual([["a", "matched", "AUTO_MATCHED_LATE_DATA"], ["b", "matched", null]]);
  }, 60_000);

  it("every unmatch rejoins the pool (DEC-064): a Currency differs unmatch pairs with a later exact counterpart", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact], 1));
    await put(sa, [{ ref: "C1", amount: 100n }]);
    await put(sb, [{ ref: "C1", amount: 100n, ccy: "USD" }]);
    await runRecon(probe, { ...r, mode: "daily", from: D });
    expect((await itemsOf(r.configId)).map((i) => [i.side, i.status, i.reason])).toEqual([["a", "break", "Currency differs"], ["b", "break", "Currency differs"]]);
    await put(sb, [{ ref: "C1", amount: 100n, date: D1 }]);
    await runRecon(probe, { ...r, mode: "daily", from: D1 });
    expect((await itemsOf(r.configId)).map((i) => [i.side, i.date, i.status, i.resolution])).toEqual([
      ["a", D, "matched", "AUTO_MATCHED_LATE_DATA"], ["b", D, "break", null], ["b", D1, "matched", null],
    ]);
  }, 60_000);

  it("carry over always (null): an unmatch 40 days old still pairs with late data; carry over 7 no longer checks it", async () => {
    const [sa, sb] = await sides();
    const kAll = await recon(A, spec(sa.sourceId, sb.sourceId, [exact], null as unknown as number));
    const k7 = await recon(A, spec(sa.sourceId, sb.sourceId, [exact], 7));
    const D40 = new Date(Date.parse(`${D}T00:00:00Z`) + 40 * 86_400_000).toISOString().slice(0, 10);
    await withSpace({ spaceIds: [A], userId: null }, (tx) => ensureMonthPartitions(tx, records, new Date(`${D40}T00:00:00Z`), 1));
    await put(sa, [{ ref: "K9", amount: 900n, date: D }]);
    for (const r of [kAll, k7]) await runRecon(probe, { ...r, mode: "daily", from: D });
    await put(sb, [{ ref: "K9", amount: 900n, date: D40 }]);
    for (const r of [kAll, k7]) await runRecon(probe, { ...r, mode: "daily", from: D40 });
    expect((await itemsOf(kAll.configId)).map((i) => [i.side, i.status, i.resolution])).toEqual([["a", "matched", "AUTO_MATCHED_LATE_DATA"], ["b", "matched", null]]);
    expect((await itemsOf(k7.configId)).map((i) => [i.side, i.status])).toEqual([["a", "break"], ["b", "break"]]);
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
    // the run keeps the carry it used, so its windows don't move as other unmatch settles later (blind review I3)
    expect(((await runOf(run.runId)).counters as { carry?: number }).carry).toBe(31);
  }, 60_000);

  it("a signed-off day is frozen: its unmatch stays out of later passes (blind review I5)", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact], null as unknown as number));
    await put(sa, [{ ref: "S1", amount: 100n, date: D }]);
    await runRecon(probe, { ...r, mode: "daily", from: D });
    await db.insert(reconDays).values({ spaceId: A, configId: r.configId, businessDate: D, status: "signed", preparedAt: new Date(), signedAt: new Date() });
    await put(sb, [{ ref: "S1", amount: 100n, date: D1 }]);
    await runRecon(probe, { ...r, mode: "daily", from: D1 });
    expect((await itemsOf(r.configId)).map((i) => [i.side, i.status])).toEqual([["a", "break"], ["b", "break"]]);
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

  it("a manual run without dates takes the schedule's current date; a signed-off date is refused", async () => {
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
    const signed = new Date(Date.parse(`${today}T00:00:00Z`) - 3 * 86_400_000).toISOString().slice(0, 10);
    await db.insert(reconDays).values({ spaceId: A, configId: r.configId, businessDate: signed, status: "signed", preparedAt: new Date(), signedAt: new Date() });
    const after = new Date(Date.parse(`${signed}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const refused = await call("POST", `/v1/spaces/${A}/recons/${r.configId}/runs`, { token, body: { from: signed, to: after } });
    expect([refused.status, ((await refused.json()) as { error: { message: string } }).error.message]).toEqual([409, SIGNED_DAY]);
    const second = await call("POST", `/v1/spaces/${A}/recons/${r.configId}/runs`, { token, body: { from: after } });
    expect(second.status).toBe(202);
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
    await put(sa, [{ ref: "K1", amount: 100n }, { ref: "K2", amount: 200n }]);
    await put(sb, [{ ref: "K1", amount: 100n }]);
    // before any run: an open day without numbers, not stale yet (its window just started)
    const none = (await todayDto(ctx, at(`${D}T00:01:00`))).recons[0]!;
    expect([none.date, none.state, none.day, none.runId, none.openBreaks, none.lastSuccessAt]).toEqual([D, "open", null, null, 0, null]);
    expect(none.schedule).toEqual({ business_date_offset: 0, from: "00:00", to: "23:59", every_minutes: 2 });

    const first = await dispatch(db, at(`${D}T10:21:00`));
    await drain("recon.tick", at(`${D}T10:21:00`));
    await finishedAt(first, at(`${D}T10:21:30`));
    const t1 = await todayDto(ctx, at(`${D}T10:22:00`));
    const x = t1.recons[0]!;
    // K2 is unmatch at the run's end (DEC-064)
    expect([x.id, x.date, x.state, x.runId, x.stale, x.openBreaks, x.running]).toEqual([r.configId, D, "open", first[0]!, false, 1, null]);
    expect([x.day!.passes["1"]!.matched, x.day!.open, x.day!.breaks]).toEqual([1, { a: 0, b: 0 }, { a: 1, b: 0 }]);
    expect(t1.sources.map((s) => s.id).sort()).toEqual([sa.sourceId, sb.sourceId].sort());
    expect(t1.capped).toBe(false);
    // no run since 10:21:30: stale past twice its 2 minutes while its window is on
    expect((await reconLive(ctx, r.configId, at(`${D}T10:25:31`))).recon.stale).toBe(true);
    // the day's sign-off stage
    await db.insert(reconDays).values({ spaceId: A, configId: r.configId, businessDate: D, status: "signed", preparedAt: new Date(), signedAt: new Date() });
    expect((await reconLive(ctx, r.configId, at(`${D}T10:25:31`))).recon.state).toBe("signed");
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
