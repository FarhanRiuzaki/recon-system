// Runs and simulations through the API and the worker's handler (Plan 3 Task 3): roles and check order per route, a
// request answered 202 queued and run by the recon.heavy handler on the app role's pool (as workerDb), one run of a
// recon at a time, the reaper, the version pinned while another publishes (Focus 5), a retried job going on after its
// last committed step (Focus 3), a simulation's changes against the published version with the submit gate, retention,
// and the Plan 3 gate's answer key through POST …/runs.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Page } from "@starterkit/shared/contracts/common";
import type { ReconRunDto, ReconRunItemDto, ReconSimChangeDto, ReconVersionDto } from "@starterkit/shared/contracts/recon";
import type { SpaceRole } from "@starterkit/shared/spaces";
import type { SQL } from "bun";
import { and, eq, isNull, sql } from "drizzle-orm";
import { sourceTestTables } from "../../../../../scripts/source-test-seed";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { appRoleDb } from "../../../../../test/helpers/app-role";
import { sourceDb } from "../../../../../test/helpers/source-db";
import type { Tx } from "../../../../kernel/db";
import { db } from "../../../../kernel/db";
import { boss, QUEUES } from "../../../../kernel/jobs";
import { ensureMonthPartitions } from "../../../../kernel/partitions";
import { activity } from "../../../audit";
import { ingestHandlers, records } from "../../../ingest";
import { reconConfigVersions } from "../../../recon";
import { spaceMembers, spaces } from "../../../spaces";
import { users } from "../../../users";
import { engineHandlers, runAndRefresh, runJob } from "../../jobs";
import { backfillRun, RunAborted } from "../../service";
import { matchGroups, reconDays, reconItems, reconRuns } from "../../schema";
import { ccyEq, D, D1, gateSource, gateSpec, makeSource, plainSource, put, recon, spec, type Src } from "../fixtures";

type Probe = Awaited<ReturnType<typeof appRoleDb>>;
let probe: Probe, src: SQL, secret: Awaited<ReturnType<typeof sourceDb>>["secret"];
let A: string, B: string;
/** mk = config_maker (A and B), op = operator, ck = config_checker, rv = reviewer (A). */
let t: Record<"mk" | "op" | "ck" | "rv", string>;

const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const message = async (r: Response) => ((await r.json()) as { error: { message: string } }).error.message;
const base = (cfg: string, s = A) => `/v1/spaces/${s}/recons/${cfg}`;
const startRun = (token: string, cfg: string, b: object = { from: D }) => call("POST", `${base(cfg)}/runs`, { token, body: b });
const simulate = (token: string, cfg: string, v: string, b: object = { from: D }) => call("POST", `${base(cfg)}/versions/${v}/simulate`, { token, body: b });
const getRun = (cfg: string, run: string, token = t.rv) => json<ReconRunDto>(call("GET", `${base(cfg)}/runs/${run}`, { token }));
const items = (cfg: string, run: string, q: string) => json<Page<ReconRunItemDto>>(call("GET", `${base(cfg)}/runs/${run}/items?${q}`, { token: t.rv }));

/** Runs every queued recon.heavy job with the handler on `on` (the app role's pool), as a worker would; completes each. */
async function drain(on: Tx = probe): Promise<void> {
  const b = await boss();
  const handle = engineHandlers(on)[QUEUES.reconHeavy]!;
  for (;;) {
    const jobs = await b.fetch(QUEUES.reconHeavy, { batchSize: 10 });
    if (!jobs.length) return;
    for (const j of jobs) {
      await handle({ id: j.id, data: j.data });
      await b.complete(QUEUES.reconHeavy, j.id);
    }
  }
}

/**
 * The app role's pool, its transactions counted from 1: `at(n)` "die" fails that one (from there on, the worker died:
 * nothing more commits, its failure is not written either), "abort" aborts `ctl` and runs it.
 */
function proxied(at: (n: number) => "die" | "abort" | null, ctl?: AbortController): Tx {
  let n = 0;
  return new Proxy(probe, {
    get: (target, key, recv) => key !== "transaction" ? Reflect.get(target, key, recv) : (...a: unknown[]) => {
      const what = at(++n);
      if (what === "die") return Promise.reject(new Error("worker died"));
      if (what === "abort") ctl!.abort();
      return (target.transaction as (...x: unknown[]) => unknown)(...a);
    },
  }) as unknown as Tx;
}

/** Two plain sources of A, published. */
const sides = async () => [await makeSource(A, plainSource()), await makeSource(A, plainSource())] as [Src, Src];
const exact = { no: 1, name: "Exact", cardinality: "1:1", blocking: [], accept: "auto", on_ambiguous: "break", predicates: [{ op: "eq", field: "ext_ref" }, { op: "eq", field: "amount_minor" }, ccyEq] };

beforeAll(async () => {
  probe = await appRoleDb();
  ({ sql: src, secret } = await sourceDb());
  await resetData();
  await db.delete(spaces);
  [A, B] = [Bun.randomUUIDv7(), Bun.randomUUIDv7()];
  await db.insert(spaces).values([{ id: A, code: "treasury", name: "Treasury" }, { id: B, code: "ctop", name: "CTOP" }]);
  const idOf = async (u: string) => (await db.select({ id: users.id }).from(users).where(eq(users.username, u)))[0]!.id;
  const who = { mk: await idOf("viewer"), op: await idOf("apple"), ck: await idOf("google"), rv: await idOf("twofa") };
  const role: Record<keyof typeof who, SpaceRole> = { mk: "config_maker", op: "operator", ck: "config_checker", rv: "reviewer" };
  await db.insert(spaceMembers).values([...Object.entries(who).map(([k, id]) => ({ spaceId: A, userId: id, role: role[k as keyof typeof who] })), { spaceId: B, userId: who.mk, role: "config_maker" }]);
  t = { mk: await signIn("viewer"), op: await signIn("apple"), ck: await signIn("google"), rv: await signIn("twofa") };
  await db.transaction((tx) => ensureMonthPartitions(tx, records, new Date(`${D}T00:00:00Z`), 1));
  await (await boss()).deleteAllJobs();
}, 60_000);
afterAll(async () => {
  await probe.$client.close();
  await src.close();
});

describe("runs and simulations through the API", () => {
  it("roles, check order and refusals", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact]));
    const unknown = Bun.randomUUIDv7();
    expect((await call("POST", `${base(r.configId)}/runs`, { body: {} })).status).toBe(401);
    expect((await startRun(t.rv, r.configId)).status).toBe(403);
    expect((await startRun(t.ck, r.configId)).status).toBe(403);
    expect((await simulate(t.op, r.configId, r.versionId)).status).toBe(403);
    expect((await startRun(t.op, unknown, { from: "2026-13-01" })).status).toBe(400); // body before 404
    expect((await startRun(t.op, r.configId, { from: D, extra: 1 })).status).toBe(400);
    expect((await startRun(t.op, unknown)).status).toBe(404);
    expect((await call("GET", `${base(r.configId, B)}/runs`, { token: t.mk })).status).toBe(404); // A's recon through B
    expect((await call("GET", `${base(r.configId)}/runs/${unknown}`, { token: t.rv })).status).toBe(404);
    expect((await call("GET", `${base(r.configId)}/runs?mode=nope`, { token: t.rv })).status).toBe(400);
    const back = await startRun(t.op, r.configId, { from: D1, to: D });
    expect([back.status, await message(back)]).toEqual([400, "Pick a business date range that starts on or before its end."]);
    const long = await startRun(t.op, r.configId, { from: "2026-11-01", to: "2026-12-02" });
    expect([long.status, await message(long)]).toEqual([400, "A run covers at most 31 business dates."]);
    const draftOnly = await recon(A, spec(sa.sourceId, sb.sourceId, [exact]), "draft");
    const none = await startRun(t.op, draftOnly.configId);
    expect([none.status, await message(none)]).toEqual([409, "This recon has no published version yet. Approve one first."]);
    const pub = await simulate(t.mk, r.configId, r.versionId);
    expect([pub.status, await message(pub)]).toEqual([409, "Only a draft can be simulated. Make a new draft from the published version."]);
    expect(await db.select().from(reconRuns).where(eq(reconRuns.configId, r.configId))).toEqual([]);
  });

  it("a run is queued (202) on its version, one at a time, run by the worker, and read by any role", async () => {
    const [sa, sb] = await sides();
    await put(sa, [{ ref: "R1", amount: 100n }, { ref: "R2", amount: 200n }, { ref: "R3", amount: 300n }]);
    await put(sb, [{ ref: "R1", amount: 100n }, { ref: "R2", amount: 200n }, { ref: "R9", amount: 900n }]);
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact]));
    const res = await startRun(t.op, r.configId);
    expect(res.status).toBe(202);
    const q = (await res.json()) as ReconRunDto;
    expect(q).toMatchObject({ configId: r.configId, versionId: r.versionId, version: 1, mode: "manual", status: "queued", from: D, to: D, doneThrough: null, baseline: null, changes: null });
    const busy = await startRun(t.mk, r.configId);
    expect([busy.status, await message(busy)]).toEqual([409, "This recon is already running. Wait for that run to finish, then start another."]);
    const [entry] = await db.select({ action: activity.action, after: activity.after }).from(activity).where(eq(activity.targetId, r.configId));
    expect(entry).toEqual({ action: "recon.run", after: { runId: q.id, version: 1, from: D, to: D } });

    await drain();
    const done = await getRun(r.configId, q.id);
    expect([done.status, done.doneThrough, done.error, done.counters.passes]).toMatchObject(["succeeded", D, null, { 1: { matched: 2, suggested: 0, broken: 0 } }]);
    // R3 and R9 waited when the run ended (its counters); the job closed the date since (past its close): breaks now
    expect([done.counters.open, done.live]).toEqual([{ a: 1, b: 1 }, { matched: 2, suggested: 0, breaks: { a: 1, b: 1 }, open: { a: 0, b: 0 }, items: { a: 3, b: 3 }, breakReasons: { "No counterpart": { a: 1, b: 1 } } }]);
    expect(done.days!.map((d) => [d.date, d.closed])).toEqual([[D, true]]);
    const list = await json<Page<ReconRunDto>>(call("GET", `${base(r.configId)}/runs`, { token: t.rv }));
    expect(list.items.map((x) => x.id)).toEqual([q.id]);
    expect((await json<Page<ReconRunDto>>(call("GET", `${base(r.configId)}/runs?mode=simulation`, { token: t.rv }))).total).toBe(0);
    const matched = await items(r.configId, q.id, "pass=1&side=a");
    expect([matched.total, matched.items.map((i) => i.extRef)]).toEqual([2, ["R1", "R2"]]);
    expect(matched.items[0]).toMatchObject({ status: "matched", amountMinor: "100", currency: "IDR", group: { passNo: 1, kind: "auto", evidence: { pass: 1, configVersionId: r.versionId } } });
    // the run left R3 and R9 open; its job then closed the date (past its close), so they are breaks now
    expect((await items(r.configId, q.id, "status=break")).items.map((i) => [i.side, i.extRef, i.breakReason])).toEqual([["a", "R3", "No counterpart"], ["b", "R9", "No counterpart"]]);
    // the next one may start now, but not over the closed date (Captain: a closed day runs again only as a rerun)
    expect((await startRun(t.mk, r.configId)).status).toBe(409);
    expect((await startRun(t.mk, r.configId, { from: D1 })).status).toBe(202);
    await drain();
  });

  it("two requests at once (a double click): exactly one run with its job, the other gets the sentence", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact]));
    const both = await Promise.all([startRun(t.op, r.configId), startRun(t.mk, r.configId)]);
    expect(both.map((x) => x.status).sort()).toEqual([202, 409]);
    expect(await message(both.find((x) => x.status === 409)!)).toBe("This recon is already running. Wait for that run to finish, then start another.");
    const runs = await db.select({ id: reconRuns.id, status: reconRuns.status }).from(reconRuns).where(eq(reconRuns.configId, r.configId));
    expect(runs.map((x) => x.status)).toEqual(["queued"]);
    expect((await (await boss()).getJobById(QUEUES.reconHeavy, runs[0]!.id))?.state).toBe("created"); // committed with its row
    await drain();
    expect((await getRun(r.configId, runs[0]!.id)).status).toBe("succeeded");
  });

  it("a reference broken again on a later date counts once for the run, once per day in days", async () => {
    const [sa, sb] = await sides();
    await put(sa, [{ ref: "X", amount: 100n, date: D }, { ref: "X", amount: 100n, date: D }, { ref: "X", amount: 100n, date: D1 }, { ref: "X", amount: 100n, date: D1 }]);
    await put(sb, [{ ref: "X", amount: 100n, date: D }, { ref: "X", amount: 100n, date: D1 }]);
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact], 0));
    const q = await json<ReconRunDto>(startRun(t.op, r.configId, { from: D, to: D1 }));
    await drain();
    const done = await getRun(r.configId, q.id);
    expect(done.counters.passes["1"]).toMatchObject({ broken: 6, brokenRefs: 1, brokenItems: { a: 4, b: 2 } });
    expect(done.days!.map((d) => [d.date, d.passes["1"]!.broken, d.passes["1"]!.brokenRefs])).toEqual([[D, 3, 1], [D1, 3, 1]]);
    // a GET between the success and the finalize (days not written, references still the steps' sum) changes nothing:
    // the finalize then writes both
    const c = (await db.select({ counters: reconRuns.counters }).from(reconRuns).where(eq(reconRuns.id, q.id)))[0]!.counters as ReconRunDto["counters"];
    c.passes["1"]!.brokenRefs = 2;
    await db.update(reconRuns).set({ days: null, finalized: false, counters: c }).where(eq(reconRuns.id, q.id));
    expect((await getRun(r.configId, q.id)).days).toBeNull();
    await drain();
    const again = await getRun(r.configId, q.id);
    expect([again.counters.passes["1"]!.brokenRefs, again.days]).toEqual([1, done.days]);
  });

  it("live counts only the run's own dates, not the carry-over date before them", async () => {
    const [sa, sb] = await sides();
    await put(sa, [{ ref: "C1", amount: 100n, date: D }, { ref: "C2", amount: 200n, date: D1 }]);
    await put(sb, [{ ref: "C1", amount: 100n, date: D }, { ref: "C2", amount: 200n, date: D1 }]);
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact], 1));
    await json<ReconRunDto>(startRun(t.op, r.configId, { from: D, to: D }));
    await drain();
    const second = await json<ReconRunDto>(startRun(t.op, r.configId, { from: D1, to: D1 }));
    await drain();
    const done = await getRun(r.configId, second.id);
    // its days hold D (carry over, the first run's pair) and D1; live only D1
    expect(done.days!.map((d) => [d.date, d.passes["1"]!.matched])).toEqual([[D, 1], [D1, 1]]);
    expect(done.live).toMatchObject({ matched: 1 });
  });

  it("DEC-047: a break a later run's suggesting pass pairs shows the proposed pair", async () => {
    const [sa, sb] = await sides();
    await put(sa, [{ ref: "P1", amount: 100n, date: D }]);
    await put(sb, [{ ref: "P1", amount: 101n, date: D1 }]);
    const near = { no: 2, name: "Near", cardinality: "1:1", blocking: ["ext_ref"], accept: "suggest", on_ambiguous: "suggest", predicates: [{ op: "amount_abs_tol", field: "amount_minor", tolerance: { IDR: "1.00" } }, ccyEq] };
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact, near], 1));
    await json<ReconRunDto>(startRun(t.op, r.configId, { from: D, to: D }));
    await drain(); // D closes: side A's P1 is a No counterpart break
    const q = await json<ReconRunDto>(startRun(t.op, r.configId, { from: D1, to: D1 }));
    await drain();
    const [row] = (await items(r.configId, q.id, "status=break&side=a")).items;
    expect([row!.extRef, row!.breakReason, row!.proposed]).toEqual(["P1", "No counterpart", { itemId: expect.any(String), side: "b", passNo: 2, extRef: "P1", amountMinor: "101", currency: "IDR", businessDate: D1 }]);
    expect((await items(r.configId, q.id, "side=b")).items[0]!.proposed).toBeNull();
    // a proposal stands for a break only: the same item no longer a break shows none
    await db.update(reconItems).set({ status: "open" }).where(eq(reconItems.id, row!.id));
    expect((await items(r.configId, q.id, "side=a")).items[0]!.proposed).toBeNull();
  });

  it("the backfill job: leaves a finalized run alone, and stops after 3 failures with days null", async () => {
    const [sa, sb] = await sides();
    await put(sa, [{ ref: "B1", amount: 100n }]);
    await put(sb, [{ ref: "B1", amount: 100n }]);
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact]));
    const q = await json<ReconRunDto>(startRun(t.op, r.configId));
    await drain();
    const done = await getRun(r.configId, q.id);
    // S1: a backfill finds it finalized with days of today's shape and changes nothing (even days that differ)
    const marked = done.days!.map((d) => ({ ...d, open: { a: 7, b: 7 } }));
    await db.update(reconRuns).set({ days: marked }).where(eq(reconRuns.id, q.id));
    await backfillRun(probe, A, q.id);
    expect((await getRun(r.configId, q.id)).days).toEqual(marked);
    // S2: a run whose days can't be written (its version gone): GET is 200 without them, queues one job per 5 minutes,
    // counts each failure and stops queueing after the third
    await db.update(reconRuns).set({ days: null, finalized: false, configVersionId: Bun.randomUUIDv7() }).where(eq(reconRuns.id, q.id));
    const b = await boss();
    const queued = async () => (await b.findJobs(QUEUES.reconHeavy, { key: `finalize:${q.id}` })).filter((j) => j.state === "created").length;
    expect([(await getRun(r.configId, q.id)).days, (await getRun(r.configId, q.id)).days, await queued()]).toEqual([null, null, 1]);
    await drain();
    await backfillRun(probe, A, q.id);
    await backfillRun(probe, A, q.id);
    const [failed] = await db.select({ n: reconRuns.finalizeAttempts, error: reconRuns.finalizeError }).from(reconRuns).where(eq(reconRuns.id, q.id));
    expect([failed!.n, failed!.error && !/select|from/i.test(failed!.error)]).toEqual([3, true]);
    await b.deleteAllJobs(QUEUES.reconHeavy); // the 5-minute slot gone too: only the count can stop it now
    expect([(await getRun(r.configId, q.id)).days, await queued()]).toEqual([null, 0]);
    await db.update(reconRuns).set({ finalizeAttempts: 2 }).where(eq(reconRuns.id, q.id));
    await getRun(r.configId, q.id);
    expect(await queued()).toBe(1);
    await b.deleteAllJobs(QUEUES.reconHeavy);
  });

  it("S3: a run's job that throws after closing a date still reads its days again", async () => {
    const [sa, sb] = await sides();
    await put(sa, [{ ref: "T9", amount: 100n }]);
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact]));
    const q = await json<ReconRunDto>(startRun(t.op, r.configId));
    await (await boss()).cancel(QUEUES.reconHeavy, q.id);
    const e = await runAndRefresh(probe, { spaceId: A, runId: q.id }, undefined, async (on, d) => {
      await runJob(on, d);
      await db.insert(reconDays).values({ spaceId: A, configId: r.configId, businessDate: D, status: "closed", closedAt: new Date() });
      throw new Error("boom");
    }).catch((x: Error) => x.message);
    expect(e).toBe("boom");
    expect((await getRun(r.configId, q.id)).days!.map((d) => [d.date, d.closed])).toEqual([[D, true]]);
  });

  it("a group's members are capped at 50 with its member count", async () => {
    const [sa, sb] = await sides();
    await put(sa, [{ ref: "S", amount: 6000n, sref: "B1" }]);
    await put(sb, Array.from({ length: 60 }, () => ({ ref: "S", amount: 100n, sref: "B1" })));
    const sum = { no: 1, name: "Batch", cardinality: "1:N", blocking: ["attrs.settlement_ref"], accept: "auto", on_ambiguous: "break", predicates: [{ op: "eq_sum", field: "amount_minor" }, ccyEq] };
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [sum]));
    const q = await json<ReconRunDto>(startRun(t.op, r.configId));
    await drain();
    const [row] = (await items(r.configId, q.id, "side=a")).items;
    expect([row!.group!.memberCount, row!.group!.members.length, row!.group!.members[0]!.side]).toEqual([61, 50, "a"]);
  });

  it("the reaper: a run whose job is over while the run is not is failed at the next request", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact]));
    const first = await json<ReconRunDto>(startRun(t.op, r.configId));
    await (await boss()).cancel(QUEUES.reconHeavy, first.id); // its worker gone for good
    const second = await startRun(t.op, r.configId);
    expect(second.status).toBe(202);
    expect(await getRun(r.configId, first.id)).toMatchObject({ status: "failed", error: "The run stopped before it finished. Run it again." });
    await drain();
    expect((await getRun(r.configId, ((await second.json()) as ReconRunDto).id)).status).toBe("succeeded");
  });

  it("Focus 5: a version published while the run waits doesn't change the run", async () => {
    const [sa, sb] = await sides();
    await put(sa, [{ ref: "P1", amount: 100n, acct: "X" }]);
    await put(sb, [{ ref: "P1", amount: 100n, acct: "Y" }]);
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact]));
    const q = await json<ReconRunDto>(startRun(t.op, r.configId));
    // version 2 (accounts must match too) is published and version 1 retires before the worker takes the run
    const v2 = Bun.randomUUIDv7();
    await db.update(reconConfigVersions).set({ status: "retired" }).where(eq(reconConfigVersions.id, r.versionId));
    await db.insert(reconConfigVersions).values({
      id: v2, configId: r.configId, spaceId: A, version: 2, status: "published", specHash: "v2", makerId: r.configId,
      spec: spec(sa.sourceId, sb.sourceId, [{ ...exact, predicates: [...exact.predicates, { op: "eq", field: "account_ref" }] }]),
    });
    await drain();
    const done = await getRun(r.configId, q.id);
    expect([done.status, done.versionId, done.version, done.counters.passes]).toMatchObject(["succeeded", r.versionId, 1, { 1: { matched: 1, suggested: 0, broken: 0 } }]);
    const groups = await db.select({ v: matchGroups.configVersionId }).from(matchGroups).where(eq(matchGroups.runId, q.id));
    expect(groups).toEqual([{ v: r.versionId }]);
  });

  it("Focus 3: a job retried after its worker died goes on after its last committed step; the result is one run's", async () => {
    const [sa, sb] = await sides();
    const rows = (s: "a" | "b") => [D, D1].flatMap((d) => [1, 2, 3].map((k) => ({ ref: `F${d}${k}`, amount: BigInt(k * 100 + (s === "b" && k === 3 ? 1 : 0)), date: d })));
    await put(sa, rows("a"));
    await put(sb, rows("b"));
    const passes = [exact, { no: 2, name: "Near", cardinality: "1:1", blocking: ["ext_ref"], accept: "suggest", on_ambiguous: "suggest", predicates: [{ op: "amount_abs_tol", field: "amount_minor", tolerance: { IDR: "1.00" } }, ccyEq] }];
    const once = await recon(A, spec(sa.sourceId, sb.sourceId, passes));
    const straight = await json<ReconRunDto>(startRun(t.op, once.configId, { from: D, to: D1 }));
    await drain();
    const want = (await getRun(once.configId, straight.id)).counters;
    expect(want.passes).toMatchObject({ 1: { matched: 4, suggested: 0, broken: 0 }, 2: { matched: 0, suggested: 2, broken: 0 } });

    const r = await recon(A, spec(sa.sourceId, sb.sourceId, passes));
    const q = await json<ReconRunDto>(startRun(t.op, r.configId, { from: D, to: D1 }));
    // transactions of a run: 1 the job's read, 2 the run's read, 3 its load, 4 partitions; per date: records' statistics,
    // side A's intake, its statistics, side B's intake, its statistics, the passes (5–10 for D, 11–16 for D1).
    // The worker dies at its 14th: D done, D1's side A taken in, side B not.
    expect(await runJob(proxied((n) => (n >= 14 ? "die" : null)), { spaceId: A, runId: q.id }).catch((e: Error) => e.message)).toBe("worker died");
    const mid = await getRun(r.configId, q.id);
    expect([mid.status, mid.doneThrough, mid.counters.intake]).toEqual(["running", D, { a: 6, b: 3 }]);
    await drain(); // pg-boss hands the job out again
    const done = await getRun(r.configId, q.id);
    expect([done.status, done.doneThrough, done.counters]).toEqual(["succeeded", D1, want]);
    const count = async (cfg: string) => (await db.select({ n: sql<number>`count(*)::int` }).from(matchGroups).where(eq(matchGroups.configId, cfg)))[0]!.n;
    expect(await count(r.configId)).toBe(await count(once.configId));
    await runJob(probe, { spaceId: A, runId: q.id }); // a retry after it ended
    expect([(await getRun(r.configId, q.id)).counters, await count(r.configId)]).toEqual([want, 6]);

    // pg-boss gives the job up (expiry) while D's passes run: the run stops before D1, running, for the retry
    const r2 = await recon(A, spec(sa.sourceId, sb.sourceId, passes));
    const q2 = await json<ReconRunDto>(startRun(t.op, r2.configId, { from: D, to: D1 }));
    const expired = new AbortController();
    const e = await runJob(proxied((n) => (n === 10 ? "abort" : null), expired), { spaceId: A, runId: q2.id }, expired.signal).catch((x: Error) => x);
    expect(e).toBeInstanceOf(RunAborted);
    const stopped = await getRun(r2.configId, q2.id);
    expect([stopped.status, stopped.doneThrough, stopped.error]).toEqual(["running", D, null]);
    await drain();
    expect((await getRun(r2.configId, q2.id)).counters).toEqual(want);
  });

  it("Focus 3: a job delivered twice at once (two handlers on one simulation) gives one run's counters and changes", async () => {
    const [sa, sb] = await sides();
    await put(sa, [{ ref: "T1", amount: 100n }, { ref: "T2", amount: 200n }, { ref: "T3", amount: 300n }]);
    await put(sb, [{ ref: "T1", amount: 100n }, { ref: "T2", amount: 201n }, { ref: "T3", amount: 300n }]);
    const near = { no: 1, name: "Near", cardinality: "1:1", blocking: ["ext_ref"], accept: "suggest", on_ambiguous: "suggest", predicates: [{ op: "amount_abs_tol", field: "amount_minor", tolerance: { IDR: "1.00" } }, ccyEq] };
    const outcome = async (twice: boolean) => {
      const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact]));
      const v2 = await json<ReconVersionDto>(call("POST", `${base(r.configId)}/versions`, { token: t.mk }));
      await call("PATCH", `${base(r.configId)}/versions/${v2.id}`, { token: t.mk, body: { spec: spec(sa.sourceId, sb.sourceId, [near]) } });
      const sim = await json<ReconRunDto>(simulate(t.mk, r.configId, v2.id));
      const data = { spaceId: A, runId: sim.id };
      if (twice) await Promise.all([runJob(probe, data), runJob(probe, data)]);
      await drain();
      const done = await getRun(r.configId, sim.id);
      const baselines = await db.select({ id: reconRuns.id }).from(reconRuns).where(eq(reconRuns.baselineOf, sim.id));
      const groups = (await db.select({ n: sql<number>`count(*)::int` }).from(matchGroups).where(eq(matchGroups.configId, r.configId)))[0]!.n;
      return [done.status, done.counters, done.changes, baselines.length, groups];
    };
    const once = await outcome(false);
    expect(once).toEqual(["succeeded", expect.anything(), { gained: 1, lost: 0, repaired: 0, kind: 2 }, 1, 5]);
    expect(await outcome(true)).toEqual(once);
  });

  it("a simulation: changes against the published version, submit opens and an edit closes it, the latest kept", async () => {
    const [sa, sb] = await sides();
    await put(sa, [
      { ref: "K1", amount: 100n, acct: "P" }, { ref: "K2", amount: 200n, acct: "P" }, { ref: "K3", amount: 300n, acct: "X" }, { ref: "K4", amount: 400n, acct: "P" },
    ]);
    await put(sb, [
      { ref: "K1", amount: 100n, acct: "P" }, { ref: "K2", amount: 700n, acct: "P" }, { ref: "K3", amount: 300n, acct: "Y" },
      { ref: "K4", amount: 400n, acct: "Q" }, { ref: "K4", amount: 405n, acct: "P" },
    ]);
    // published: reference and amount, auto. draft: reference and account, amount within 10.00, suggested.
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact]));
    const draftSpec = (tol: string) => spec(sa.sourceId, sb.sourceId, [{
      no: 1, name: "Near", cardinality: "1:1", blocking: ["ext_ref"], accept: "suggest", on_ambiguous: "suggest",
      predicates: [{ op: "eq", field: "account_ref" }, { op: "amount_abs_tol", field: "amount_minor", tolerance: { IDR: tol } }, ccyEq],
    }]);
    const v2 = await json<ReconVersionDto>(call("POST", `${base(r.configId)}/versions`, { token: t.mk }));
    expect((await call("PATCH", `${base(r.configId)}/versions/${v2.id}`, { token: t.mk, body: { spec: draftSpec("10.00") } })).status).toBe(200);
    const res = await simulate(t.mk, r.configId, v2.id);
    expect(res.status).toBe(202);
    const sim = (await res.json()) as ReconRunDto;
    expect(sim).toMatchObject({ mode: "simulation", status: "queued", version: 2, baseline: null, changes: null });
    await drain();
    const done = await getRun(r.configId, sim.id);
    expect([done.status, done.baseline?.version, done.changes]).toEqual(["succeeded", 1, { gained: 1, lost: 1, repaired: 1, kind: 1 }]);
    const changes = await json<Page<ReconSimChangeDto>>(call("GET", `${base(r.configId)}/runs/${sim.id}/changes`, { token: t.rv }));
    const refs = (g: ReconSimChangeDto["draft"]) => g?.members.map((m) => `${m.side}:${m.extRef}:${m.amountMinor}`) ?? null;
    expect(changes.items.map((c) => [c.change, refs(c.draft), refs(c.published)]).sort()).toEqual([
      ["gained", ["a:K2:200", "b:K2:700"], null],
      ["kind", ["a:K1:100", "b:K1:100"], ["a:K1:100", "b:K1:100"]],
      ["lost", null, ["a:K3:300", "b:K3:300"]],
      ["repaired", ["a:K4:400", "b:K4:405"], ["a:K4:400", "b:K4:400"]],
    ]);
    const kinds = changes.items.find((c) => c.change === "kind")!;
    expect([kinds.draft?.kind, kinds.published?.kind]).toEqual(["suggested", "auto"]);
    expect((await json<Page<ReconSimChangeDto>>(call("GET", `${base(r.configId)}/runs/${sim.id}/changes?change=lost`, { token: t.rv }))).total).toBe(1);
    // the published version's simulation is not a run of its own in the list; no live item was made
    expect((await json<Page<ReconRunDto>>(call("GET", `${base(r.configId)}/runs`, { token: t.rv }))).items.map((x) => x.id)).toEqual([sim.id]);
    expect(await db.select().from(reconItems).where(and(eq(reconItems.configId, r.configId), isNull(reconItems.simRunId)))).toEqual([]);

    // the simulation ran on the draft as it is: submit opens; the caller became a contributor
    const v = await json<ReconVersionDto>(call("GET", `${base(r.configId)}/versions/${v2.id}`, { token: t.mk }));
    expect(v.simulatedHash).toBe(v.specHash);
    expect((await call("PATCH", `${base(r.configId)}/versions/${v2.id}`, { token: t.mk, body: { spec: draftSpec("20.00") } })).status).toBe(200);
    const stale = await call("POST", `${base(r.configId)}/versions/${v2.id}/submit`, { token: t.mk });
    expect([stale.status, await message(stale)]).toEqual([400, "The draft changed after the last simulation. Run it again."]);
    const again = await json<ReconRunDto>(simulate(t.mk, r.configId, v2.id));
    await drain();
    expect((await getRun(r.configId, again.id)).status).toBe("succeeded");
    expect((await call("POST", `${base(r.configId)}/versions/${v2.id}/submit`, { token: t.mk })).status).toBe(200);
    // retention: the version's older simulation went, with its published-version run, items, groups and changes
    const sims = await db.select({ id: reconRuns.id, of: reconRuns.baselineOf }).from(reconRuns).where(eq(reconRuns.configId, r.configId));
    expect(sims.length).toBe(2);
    expect(sims.find((x) => !x.of)?.id).toBe(again.id);
    expect(await db.select().from(reconItems).where(eq(reconItems.simRunId, sim.id))).toEqual([]);
    expect((await call("GET", `${base(r.configId)}/runs/${sim.id}`, { token: t.rv })).status).toBe(404);
  });

  it("a simulation of a draft edited after it was asked for fails in a sentence and opens nothing", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact]), "draft");
    const sim = await json<ReconRunDto>(simulate(t.mk, r.configId, r.versionId));
    expect((await call("PATCH", `${base(r.configId)}/versions/${r.versionId}`, { token: t.mk, body: { spec: spec(sa.sourceId, sb.sourceId, [exact], 2) } })).status).toBe(200);
    await drain();
    expect(await getRun(r.configId, sim.id)).toMatchObject({ status: "failed", error: "The draft changed after this simulation was asked for. Run the simulation again." });
    const [v] = await db.select({ h: reconConfigVersions.simulatedHash }).from(reconConfigVersions).where(eq(reconConfigVersions.id, r.versionId));
    expect(v!.h).toBeNull();
  });
});

describe("discarding a draft (owner, 22 Nov: Cancel while editing)", () => {
  it("a config maker discards an open draft with its simulations; the published version runs on; review, only version and others refused", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact]));
    const v2 = await json<ReconVersionDto>(call("POST", `${base(r.configId)}/versions`, { token: t.mk }));
    const sim = await json<ReconRunDto>(simulate(t.mk, r.configId, v2.id));
    await drain();
    const del = (token: string, v = v2.id, cfg = r.configId) => call("DELETE", `${base(cfg)}/versions/${v}`, { token });
    expect((await del(t.op)).status).toBe(403);
    expect((await del(t.mk, Bun.randomUUIDv7())).status).toBe(404);
    expect((await del(t.mk)).status).toBe(204);
    expect(await db.select().from(reconConfigVersions).where(eq(reconConfigVersions.id, v2.id))).toEqual([]);
    expect(await db.select().from(reconRuns).where(eq(reconRuns.id, sim.id))).toEqual([]);
    expect(await db.select().from(reconRuns).where(eq(reconRuns.baselineOf, sim.id))).toEqual([]);
    expect((await db.select({ status: reconConfigVersions.status }).from(reconConfigVersions).where(eq(reconConfigVersions.configId, r.configId))).map((x) => x.status)).toEqual(["published"]);
    const [entry] = await db.select().from(activity).where(eq(activity.action, "recon.version_discard"));
    expect(entry).toMatchObject({ targetId: r.configId, before: { version: v2.version } });
    // a version in review waits for its checker; a recon never approved is deleted whole instead
    const v3 = await json<ReconVersionDto>(call("POST", `${base(r.configId)}/versions`, { token: t.mk }));
    await db.update(reconConfigVersions).set({ status: "in_review" }).where(eq(reconConfigVersions.id, v3.id));
    expect((await del(t.mk, v3.id)).status).toBe(409);
    const only = await recon(A, spec(sa.sourceId, sb.sourceId, [exact]), "draft");
    expect((await del(t.mk, only.versionId, only.configId)).status).toBe(409);
  });
});

describe("the Plan 3 gate through POST …/runs and the worker's handler", () => {
  let gate: Awaited<ReturnType<typeof recon>>;
  beforeAll(async () => {
    await src.unsafe("create schema if not exists core");
    await src.begin((tx) => tx.unsafe(sourceTestTables()));
    const [s1, s2] = [await makeSource(A, gateSource(1), secret), await makeSource(A, gateSource(2), secret)];
    const pull = ingestHandlers(probe)[QUEUES.ingestPull]!;
    for (const s of [s1, s2]) await pull({ id: "t", data: { spaceId: s.spaceId, sourceId: s.sourceId } });
    gate = await recon(A, gateSpec(s1.sourceId, s2.sourceId));
  }, 60_000);

  it("matches the answer key (docs/recon/source-test-db.md) per pass, per outcome and per side", async () => {
    const q = await json<ReconRunDto>(startRun(t.op, gate.configId, { from: "2026-11-02", to: "2026-11-05" }));
    await drain();
    const done = await getRun(gate.configId, q.id);
    expect([done.status, done.doneThrough]).toEqual(["succeeded", "2026-11-05"]);
    const side = (a: number, b = a) => ({ a, b });
    const pass = (matched: number, suggested: number, broken: number, brokenRefs: number) => ({
      matched, suggested, broken, brokenRefs, matchedItems: side(matched), suggestedItems: side(suggested), brokenItems: side(broken / 2),
    });
    // what the run itself did (its counters: 24 · 24 waiting when it ended); what stands now is `live` (below)
    expect(done.counters).toEqual({
      intake: side(1000), replaced: side(0),
      passes: { 1: pass(937, 0, 30, 10), 2: pass(0, 14, 0, 0), 3: pass(0, 10, 0, 0) },
      open: side(24),
    });
    // per side the funnel adds up: 1,000 = 937 matched + 15 duplicate + 48 left (24 suggested, 24 waiting, closed since)
    const ps = Object.values(done.counters.passes);
    for (const k of ["a", "b"] as const) {
      const sum = (f: "matchedItems" | "suggestedItems" | "brokenItems") => ps.reduce((n, x) => n + x[f]![k], 0);
      expect([sum("matchedItems"), sum("brokenItems"), sum("suggestedItems") + 24]).toEqual([937, 15, 48]);
    }

    // the per-date strip (matched / suggested / waiting a · b / duplicate items), a group on its latest member's date;
    // nothing waits once the dates closed
    // the worker's handler then closed 2–5 Nov (past their close, data complete; Captain: any run closes, DEC-046): per
    // side 937 matched, the 15 Duplicate, the 24 unconfirmed suggestions with their pass's reason (14 Amount differs,
    // 10 Date differs), and of the 24 waiting 3 Currency differs, 1 Amount differs and 20 No counterpart
    const after = await db.select({ side: reconItems.side, status: reconItems.status, reason: reconItems.breakReason, n: sql<number>`count(*)::int` }).from(reconItems)
      .where(and(eq(reconItems.configId, gate.configId), isNull(reconItems.simRunId))).groupBy(reconItems.side, reconItems.status, reconItems.breakReason)
      .orderBy(reconItems.side, reconItems.status, reconItems.breakReason);
    const perSide = [["break", "Amount differs", 15], ["break", "Currency differs", 3], ["break", "Date differs", 10], ["break", "Duplicate", 15], ["break", "No counterpart", 20], ["matched", null, 937]];
    expect(after.map((x) => [x.side, x.status, x.reason, x.n])).toEqual([...perSide.map((x) => ["a", ...x]), ...perSide.map((x) => ["b", ...x])]);

    const days = (await getRun(gate.configId, q.id)).days!;
    const strip = days.map((d) => {
      const p = Object.values(d.passes);
      const sum = (f: "matched" | "suggested" | "broken") => p.reduce((n, x) => n + x[f], 0);
      return [d.date, sum("matched"), sum("suggested"), d.open.a, d.open.b, sum("broken")];
    });
    // the suggestions are breaks since the close (their pairs kept): no date counts them as suggested any more
    expect(strip).toEqual([
      ["2026-11-02", 312, 0, 0, 0, 12],
      ["2026-11-03", 313, 0, 0, 0, 9],
      ["2026-11-04", 312, 0, 0, 0, 9],
      ["2026-11-05", 0, 0, 0, 0, 0],
    ]);
    // every day closed: per side 48 breaks of time (3 currency + 1 amount + 20 no counterpart + 24 unconfirmed), nothing waits
    expect(days.every((d) => d.closed)).toBe(true);
    expect((await getRun(gate.configId, q.id)).live).toEqual({
      matched: 937, suggested: 0, breaks: side(48), open: side(0), items: side(1000),
      breakReasons: { "Amount differs": side(15), "Currency differs": side(3), "Date differs": side(10), Duplicate: side(15), "No counterpart": side(20) },
    });
    // the Breaks tab: one reason, the run's own dates only; a reason the engine never writes is refused
    expect((await items(gate.configId, q.id, "reason=No%20counterpart&own=1")).total).toBe(40);
    expect((await call("GET", `${base(gate.configId)}/runs/${q.id}/items?reason=Gone`, { token: t.rv })).status).toBe(400);
    expect(days.reduce((n, d) => n + d.passes["1"]!.brokenRefs, 0)).toBe(10);
    // a run whose days are missing (before 0032, or failed): GET answers 200 without them (it never aggregates on the
    // API's pool) and queues the worker's finalize; the next GET has the same days
    const asStored = await getRun(gate.configId, q.id);
    await db.update(reconRuns).set({ days: null, finalized: false }).where(eq(reconRuns.id, q.id));
    const missing = await call("GET", `${base(gate.configId)}/runs/${q.id}`, { token: t.rv });
    expect([missing.status, ((await missing.json()) as ReconRunDto).days, (await getRun(gate.configId, q.id)).live]).toEqual([200, null, null]);
    await drain();
    expect([(await getRun(gate.configId, q.id)).days, (await getRun(gate.configId, q.id)).live]).toEqual([asStored.days, asStored.live]);
    // days of an older shape (no `items`) count as missing the same way
    await db.update(reconRuns).set({ days: asStored.days!.map(({ items: _, ...d }) => d) }).where(eq(reconRuns.id, q.id));
    await (await boss()).deleteAllJobs(QUEUES.reconHeavy); // past the 5-minute slot of the job before
    expect((await getRun(gate.configId, q.id)).days).toBeNull();
    await drain();
    expect((await getRun(gate.configId, q.id)).days).toEqual(asStored.days);
    expect((await call("GET", `${base(gate.configId)}/runs`, { token: t.rv }).then((r) => r.json()) as Page<ReconRunDto>).items[0]!.days).toBeNull();

    const total = async (q2: string) => (await items(gate.configId, q.id, q2)).total;
    // pass 1 = its 937 pairs and the 30 items it broke as Duplicate
    expect([await total("pass=1"), await total("pass=2"), await total("pass=3")]).toEqual([1904, 28, 20]);
    expect([await total("status=break"), await total("status=suggested"), await total("status=open&side=a"), await total("status=open&side=b")]).toEqual([126, 0, 0, 0]);
    const dup = await items(gate.configId, q.id, "pass=1&status=break&pageSize=100");
    expect([new Set(dup.items.map((i) => i.breakReason)), new Set(dup.items.map((i) => i.breakPass)), new Set(dup.items.map((i) => i.extRef)).size])
      .toEqual([new Set(["Duplicate"]), new Set([1]), 10]);
    // the date filter counts as the strip does: 3 Nov = 313 pairs + 8 suggested (both sides) + 16 waiting + 9 duplicate,
    // the suggested and waiting ones breaks since the close
    expect(await total("date=2026-11-03")).toBe(2 * 313 + 2 * 8 + 16 + 9);
    expect([await total("date=2026-11-03&pass=1&status=matched"), await total("date=2026-11-05&status=break")]).toEqual([626, 8]);
    // a pair is one row: the item's group has both sides' records
    const [row] = (await items(gate.configId, q.id, "pass=2&side=a&pageSize=15")).items;
    expect(row!.group!.members.map((m) => [m.side, m.extRef === row!.extRef, m.currency])).toEqual([["a", true, "IDR"], ["b", true, "IDR"]]);
    expect(row!.group!.memberCount).toBe(2);
    expect(BigInt(row!.group!.members[1]!.amountMinor!) - BigInt(row!.group!.members[0]!.amountMinor!)).toBe(50000n);
  }, 60_000);

  it("records=1 lists the runs whose own dates hold records: the gate run, not an empty catch-up after it", async () => {
    const [gateRun] = (await json<Page<ReconRunDto>>(call("GET", `${base(gate.configId)}/runs?mode=manual`, { token: t.rv }))).items;
    const empty = await json<ReconRunDto>(startRun(t.op, gate.configId, { from: "2026-11-06", to: "2026-11-20" }));
    await drain();
    expect((await getRun(gate.configId, empty.id)).status).toBe("succeeded");
    const withRecords = await json<Page<ReconRunDto>>(call("GET", `${base(gate.configId)}/runs?records=1`, { token: t.rv }));
    expect(withRecords.items.map((x) => x.id)).toEqual([gateRun!.id]);
    // a run without stored days is unknown: left out
    await db.update(reconRuns).set({ days: null, finalized: false }).where(eq(reconRuns.id, gateRun!.id));
    expect((await json<Page<ReconRunDto>>(call("GET", `${base(gate.configId)}/runs?records=1`, { token: t.rv }))).total).toBe(0);
    await (await boss()).deleteAllJobs(QUEUES.reconHeavy);
    expect((await getRun(gate.configId, gateRun!.id)).days).toBeNull(); // queues its backfill
    await drain();
    expect((await json<Page<ReconRunDto>>(call("GET", `${base(gate.configId)}/runs?records=1`, { token: t.rv }))).items.map((x) => x.id)).toEqual([gateRun!.id]);
  }, 60_000);

  it("a simulation of the same spec as a draft changes no pair and opens submit", async () => {
    const v2 = await json<ReconVersionDto>(call("POST", `${base(gate.configId)}/versions`, { token: t.mk }));
    const sim = await json<ReconRunDto>(simulate(t.mk, gate.configId, v2.id, { from: "2026-11-02", to: "2026-11-05" }));
    await drain();
    const done = await getRun(gate.configId, sim.id);
    expect([done.status, done.changes, done.counters.passes]).toMatchObject([
      "succeeded", { gained: 0, lost: 0, repaired: 0, kind: 0 },
      { 1: { matched: 937, suggested: 0, broken: 30 }, 2: { matched: 0, suggested: 14, broken: 0 }, 3: { matched: 0, suggested: 10, broken: 0 } },
    ]);
    const v = await json<ReconVersionDto>(call("GET", `${base(gate.configId)}/versions/${v2.id}`, { token: t.mk }));
    expect(v.simulatedHash).toBe(v.specHash);
    // day close as the simulation projects it (the classifier day close uses; nothing broken): 24 waiting per side
    const atClose = { "Currency differs": 3, "Amount differs": 1, "No counterpart": 20 };
    expect([done.projection?.a, done.projection?.b, done.projection?.unconfirmed]).toEqual([atClose, atClose, { a: 24, b: 24 }]);
    const perDayUnconfirmed = done.projection!.days.reduce((n, d) => n + d.unconfirmed.a, 0);
    expect(perDayUnconfirmed).toBe(24);
    const perDay = (k: "a" | "b") => done.projection!.days.reduce((n, d) => n + Object.values(d[k]).reduce((x, y) => x + y, 0), 0);
    expect([perDay("a"), perDay("b"), done.counters.open]).toEqual([24, 24, { a: 24, b: 24 }]);
    expect(Object.keys(done.counters)).not.toContain("projection");
    expect((await items(gate.configId, sim.id, "status=break")).total).toBe(30); // only the Duplicates are broken
  }, 60_000);
});
