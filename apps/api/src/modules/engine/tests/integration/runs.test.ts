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
import { engineHandlers, runJob } from "../../jobs";
import { matchGroups, reconItems, reconRuns } from "../../schema";
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
    expect([done.status, done.doneThrough, done.error, done.counters.passes]).toEqual(["succeeded", D, null, { 1: { matched: 2, suggested: 0, broken: 0 } }]);
    expect(done.counters.open).toEqual({ a: 1, b: 1 });
    const list = await json<Page<ReconRunDto>>(call("GET", `${base(r.configId)}/runs`, { token: t.rv }));
    expect(list.items.map((x) => x.id)).toEqual([q.id]);
    expect((await json<Page<ReconRunDto>>(call("GET", `${base(r.configId)}/runs?mode=simulation`, { token: t.rv }))).total).toBe(0);
    const matched = await items(r.configId, q.id, "pass=1&side=a");
    expect([matched.total, matched.items.map((i) => i.extRef)]).toEqual([2, ["R1", "R2"]]);
    expect(matched.items[0]).toMatchObject({ status: "matched", amountMinor: "100", currency: "IDR", group: { passNo: 1, kind: "auto", evidence: { pass: 1, configVersionId: r.versionId } } });
    expect((await items(r.configId, q.id, "status=open")).items.map((i) => [i.side, i.extRef, i.group])).toEqual([["a", "R3", null], ["b", "R9", null]]);
    // the next one may start now
    expect((await startRun(t.mk, r.configId)).status).toBe(202);
    await drain();
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
    expect([done.status, done.versionId, done.version, done.counters.passes]).toEqual(["succeeded", r.versionId, 1, { 1: { matched: 1, suggested: 0, broken: 0 } }]);
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
    expect(want.passes).toEqual({ 1: { matched: 4, suggested: 0, broken: 0 }, 2: { matched: 0, suggested: 2, broken: 0 } });

    const r = await recon(A, spec(sa.sourceId, sb.sourceId, passes));
    const q = await json<ReconRunDto>(startRun(t.op, r.configId, { from: D, to: D1 }));
    // the worker dies at its 6th transaction: after the run's read, its load, the partitions and the step of D
    let n = 0;
    const dying = new Proxy(probe, {
      get: (target, key, recv) => (key === "transaction" ? (...a: unknown[]) => (++n >= 6 ? Promise.reject(new Error("worker died")) : (target.transaction as (...x: unknown[]) => unknown)(...a)) : Reflect.get(target, key, recv)),
    }) as unknown as Tx;
    expect(await runJob(dying, { spaceId: A, runId: q.id }).catch((e: Error) => e.message)).toBe("worker died");
    const mid = await getRun(r.configId, q.id);
    expect([mid.status, mid.doneThrough, mid.counters.intake]).toEqual(["running", D, { a: 3, b: 3 }]);
    await drain(); // pg-boss hands the job out again
    const done = await getRun(r.configId, q.id);
    expect([done.status, done.doneThrough, done.counters]).toEqual(["succeeded", D1, want]);
    const count = async (cfg: string) => (await db.select({ n: sql<number>`count(*)::int` }).from(matchGroups).where(eq(matchGroups.configId, cfg)))[0]!.n;
    expect(await count(r.configId)).toBe(await count(once.configId));
    await runJob(probe, { spaceId: A, runId: q.id }); // a retry after it ended
    expect([(await getRun(r.configId, q.id)).counters, await count(r.configId)]).toEqual([want, 6]);
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
    expect(done.counters).toEqual({
      intake: { a: 1000, b: 1000 }, replaced: { a: 0, b: 0 },
      passes: { 1: { matched: 937, suggested: 0, broken: 30 }, 2: { matched: 0, suggested: 14, broken: 0 }, 3: { matched: 0, suggested: 10, broken: 0 } },
      open: { a: 24, b: 24 },
    });
    const total = async (q2: string) => (await items(gate.configId, q.id, q2)).total;
    expect([await total("pass=1"), await total("pass=2"), await total("pass=3")]).toEqual([1874, 28, 20]);
    expect([await total("status=break"), await total("status=suggested"), await total("status=open&side=a"), await total("status=open&side=b")]).toEqual([30, 48, 24, 24]);
    const dup = await items(gate.configId, q.id, "status=break&pageSize=100");
    expect(new Set(dup.items.map((i) => i.breakReason))).toEqual(new Set(["Duplicate"]));
  }, 60_000);

  it("a simulation of the same spec as a draft changes no pair and opens submit", async () => {
    const v2 = await json<ReconVersionDto>(call("POST", `${base(gate.configId)}/versions`, { token: t.mk }));
    const sim = await json<ReconRunDto>(simulate(t.mk, gate.configId, v2.id, { from: "2026-11-02", to: "2026-11-05" }));
    await drain();
    const done = await getRun(gate.configId, sim.id);
    expect([done.status, done.changes, done.counters.passes]).toEqual([
      "succeeded", { gained: 0, lost: 0, repaired: 0, kind: 0 },
      { 1: { matched: 937, suggested: 0, broken: 30 }, 2: { matched: 0, suggested: 14, broken: 0 }, 3: { matched: 0, suggested: 10, broken: 0 } },
    ]);
    const v = await json<ReconVersionDto>(call("GET", `${base(gate.configId)}/versions/${v2.id}`, { token: t.mk }));
    expect(v.simulatedHash).toBe(v.specHash);
  }, 60_000);
});
