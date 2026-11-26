// A rollback of a recon's runs (rollback.ts, jobs.ts requestRollback): a space admin only, check order and the refusals
// of the request; the rerun's job undoing what the run and every live run after it matched and broke (groups reversed
// rolled_back, members and breaks back to open), then matching the dates again; and the refusals at the job (a closed
// carry-over date, a change waiting for a decision), which fail the rerun and change nothing.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { ReconRunDto, RollbackRunDto } from "@starterkit/shared/contracts/recon";
import type { SpaceRole } from "@starterkit/shared/spaces";
import { and, eq, isNull } from "drizzle-orm";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { appRoleDb } from "../../../../../test/helpers/app-role";
import type { Tx } from "../../../../kernel/db";
import { db } from "../../../../kernel/db";
import { boss, QUEUES } from "../../../../kernel/jobs";
import { ensureMonthPartitions } from "../../../../kernel/partitions";
import { approvalRequests } from "../../../approvals";
import { activity } from "../../../audit";
import { records } from "../../../ingest";
import { spaceMembers, spaces } from "../../../spaces";
import { users } from "../../../users";
import { engineHandlers } from "../../jobs";
import { runRecon } from "../../service";
import { matchGroups, reconDays, reconItems, reconRuns } from "../../schema";
import { ccyEq, D, D1, makeSource, plainSource, put, recon, spec, type Src } from "../fixtures";

let probe: Awaited<ReturnType<typeof appRoleDb>>;
let A: string;
/** sa = space_admin, op = operator, rv = reviewer (space A). */
let t: Record<"sa" | "op" | "rv", string>;

const message = async (r: Response) => ((await r.json()) as { error: { message: string } }).error.message;
const base = (cfg: string) => `/v1/spaces/${A}/recons/${cfg}`;
const rollback = (token: string | undefined, cfg: string, run: string) => call("POST", `${base(cfg)}/runs/${run}/rollback`, { token });
const getRun = async (cfg: string, run: string) => (await (await call("GET", `${base(cfg)}/runs/${run}`, { token: t.rv })).json()) as ReconRunDto;
const exact = { no: 1, name: "Exact", cardinality: "1:1", blocking: [], accept: "auto", on_ambiguous: "break", predicates: [{ op: "eq", field: "ext_ref" }, { op: "eq", field: "amount_minor" }, ccyEq] };
const sides = async () => [await makeSource(A, plainSource()), await makeSource(A, plainSource())] as [Src, Src];
const live = (r: { configId: string; versionId: string }) => ({ spaceId: A, configId: r.configId, versionId: r.versionId, mode: "manual" as const });

/** Runs every queued recon.heavy job with the worker's handler on the app role's pool; completes each. */
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

/** The live groups of a config: run, reversal and its members' references, oldest first. */
async function groupsOf(configId: string) {
  const gs = await db.select().from(matchGroups).where(and(eq(matchGroups.configId, configId), isNull(matchGroups.simRunId))).orderBy(matchGroups.createdAt, matchGroups.id);
  return gs.map((g) => ({ run: g.runId, reversedBy: g.reversedBy, reason: g.reverseReason }));
}
const itemsOf = (configId: string) => db.select({ status: reconItems.status, breakRunId: reconItems.breakRunId, breakReason: reconItems.breakReason, side: reconItems.side })
  .from(reconItems).where(and(eq(reconItems.configId, configId), isNull(reconItems.simRunId))).orderBy(reconItems.side, reconItems.recordId);

beforeAll(async () => {
  probe = await appRoleDb();
  await resetData();
  await db.delete(spaces);
  A = Bun.randomUUIDv7();
  await db.insert(spaces).values({ id: A, code: "treasury", name: "Treasury" });
  const idOf = async (u: string) => (await db.select({ id: users.id }).from(users).where(eq(users.username, u)))[0]!.id;
  const who = { sa: await idOf("viewer"), op: await idOf("apple"), rv: await idOf("twofa") };
  const role: Record<keyof typeof who, SpaceRole> = { sa: "space_admin", op: "operator", rv: "reviewer" };
  await db.insert(spaceMembers).values(Object.entries(who).map(([k, id]) => ({ spaceId: A, userId: id, role: role[k as keyof typeof who] })));
  t = { sa: await signIn("viewer"), op: await signIn("apple"), rv: await signIn("twofa") };
  await db.transaction((tx) => ensureMonthPartitions(tx, records, new Date(`${D}T00:00:00Z`), 1));
  await (await boss()).deleteAllJobs();
}, 60_000);
afterAll(async () => {
  await probe.$client.close();
});

describe("rolling back a run", () => {
  it("a space admin only; check order and the request's refusals change nothing", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact]));
    const { runId } = await runRecon(probe, { ...live(r), from: D });
    expect((await rollback(undefined, r.configId, runId)).status).toBe(401);
    expect((await rollback(t.op, r.configId, runId)).status).toBe(403);
    expect((await rollback(t.rv, r.configId, runId)).status).toBe(403);
    expect((await rollback(t.sa, r.configId, "not-a-uuid")).status).toBe(404);
    expect((await rollback(t.sa, r.configId, Bun.randomUUIDv7())).status).toBe(404);
    expect((await rollback(t.sa, Bun.randomUUIDv7(), runId)).status).toBe(404);
    // a simulation changes no live item
    const sim = await runRecon(probe, { ...live(r), mode: "simulation", from: D });
    const s = await rollback(t.sa, r.configId, sim.runId);
    expect([s.status, await message(s)]).toEqual([400, "A simulation changes no live items, so there is nothing to roll back."]);
    // the runs from this one on cover more than a rerun may
    const far = await runRecon(probe, { ...live(r), from: "2026-12-14" });
    const long = await rollback(t.sa, r.configId, runId);
    expect([long.status, await message(long)]).toEqual([400, "This run and the ones after it cover 43 business dates; a rerun covers at most 31. Roll back a later run."]);
    // a closed date in their range
    await db.insert(reconDays).values({ spaceId: A, configId: r.configId, businessDate: "2026-12-14", status: "closed", closedAt: new Date() });
    const shut = await rollback(t.sa, r.configId, far.runId);
    expect([shut.status, await message(shut)]).toEqual([409, "Business date 2026-12-14 is closed, so what these runs did there stays. Roll back a run after it."]);
    // a run not ended
    await db.update(reconRuns).set({ status: "running" }).where(eq(reconRuns.id, far.runId));
    const busy = await rollback(t.sa, r.configId, far.runId);
    expect([busy.status, await message(busy)]).toEqual([409, "This run hasn't ended yet. Roll it back once it ends."]);
    expect(await db.select().from(reconRuns).where(and(eq(reconRuns.configId, r.configId), eq(reconRuns.mode, "rerun")))).toEqual([]);
    expect(await db.select().from(activity).where(eq(activity.action, "recon.run_rollback"))).toEqual([]);
  }, 60_000);

  it("undoes what the run and every one after it matched and broke, then matches the dates again", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact]));
    // a run before it (nothing to read yet), then the run rolled back (R1 matched, R3 a Duplicate), then one after it (R2 on D1)
    const before = await runRecon(probe, { ...live(r), from: D });
    await put(sa, [{ ref: "R1", amount: 100n }, { ref: "R3", amount: 300n }, { ref: "R3", amount: 300n }]);
    await put(sb, [{ ref: "R1", amount: 100n }, { ref: "R3", amount: 300n }]);
    const x = await runRecon(probe, { ...live(r), from: D });
    await put(sa, [{ ref: "R2", amount: 200n, date: D1 }]);
    await put(sb, [{ ref: "R2", amount: 200n, date: D1 }]);
    const y = await runRecon(probe, { ...live(r), from: D1 });
    expect((await groupsOf(r.configId)).filter((g) => !g.reversedBy).map((g) => g.run)).toEqual([x.runId, y.runId]);
    expect((await itemsOf(r.configId)).filter((i) => i.status === "break").map((i) => [i.side, i.breakReason, i.breakRunId])).toEqual([
      ["a", "Duplicate", x.runId], ["a", "Duplicate", x.runId], ["b", "Duplicate", x.runId],
    ]);

    const res = await rollback(t.sa, r.configId, x.runId);
    expect(res.status).toBe(202);
    const body = (await res.json()) as RollbackRunDto;
    expect(body).toMatchObject({ runs: 2, rerun: { mode: "rerun", status: "queued", from: D, to: D1, rollbackOf: x.runId, rolledBackAt: null } });
    const [entry] = await db.select({ after: activity.after }).from(activity).where(and(eq(activity.action, "recon.run_rollback"), eq(activity.targetId, r.configId)));
    expect(entry!.after).toMatchObject({ runId: x.runId, runs: 2, rerunId: body.rerun.id, version: 1, from: D, to: D1 });
    // one rollback at a time: the rerun is a run under way
    const again = await rollback(t.sa, r.configId, y.runId);
    expect([again.status, await message(again)]).toEqual([409, "This recon is already running. Wait for that run to finish, then start another."]);

    await drain();
    const rerun = await getRun(r.configId, body.rerun.id);
    expect([rerun.status, rerun.error]).toEqual(["succeeded", null]);
    // the run before it stands; the two rolled back are marked; their groups reversed by the rerun, never deleted
    expect((await getRun(r.configId, before.runId)).rolledBackAt).toBeNull();
    expect((await getRun(r.configId, x.runId)).rolledBackAt).not.toBeNull();
    expect((await getRun(r.configId, y.runId)).rolledBackAt).not.toBeNull();
    const groups = await groupsOf(r.configId);
    expect(groups.filter((g) => g.run === x.runId || g.run === y.runId)).toEqual([
      { run: x.runId, reversedBy: body.rerun.id, reason: "rolled_back" }, { run: y.runId, reversedBy: body.rerun.id, reason: "rolled_back" },
    ]);
    // the rerun matched R1 and R2 again and broke R3 again: its own now
    expect(groups.filter((g) => !g.reversedBy).map((g) => g.run)).toEqual([body.rerun.id, body.rerun.id]);
    expect((await itemsOf(r.configId)).filter((i) => i.status === "break").map((i) => i.breakRunId)).toEqual([body.rerun.id, body.rerun.id, body.rerun.id]);
    // once rolled back, it stays so
    const twice = await rollback(t.sa, r.configId, x.runId);
    expect([twice.status, await message(twice)]).toEqual([409, "This run was rolled back already."]);
  }, 60_000);

  it("a closed carry-over date or a change waiting for a decision fails the rerun and changes nothing", async () => {
    const [sa, sb] = await sides();
    // R1 of D on side A pairs with R1 of D1 on side B (carry over 1): the group dated D1 holds an item of D
    const [a1] = await put(sa, [{ ref: "R1", amount: 100n }, { ref: "R3", amount: 300n }, { ref: "R3", amount: 300n }]);
    await put(sb, [{ ref: "R1", amount: 100n, date: D1 }, { ref: "R3", amount: 300n }]);
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact]));
    const x = await runRecon(probe, { ...live(r), from: D, to: D1 });
    const groups = await groupsOf(r.configId);
    expect(groups).toEqual([{ run: x.runId, reversedBy: null, reason: null }]);
    const items = await itemsOf(r.configId);
    const rolled = async () => {
      const res = await rollback(t.sa, r.configId, x.runId);
      expect(res.status).toBe(202);
      const id = ((await res.json()) as RollbackRunDto).rerun.id;
      await drain();
      return getRun(r.configId, id);
    };
    // the run's range is D–D1, but the rollback would change a break on D: once D is closed, the rerun refuses
    await db.insert(reconDays).values({ spaceId: A, configId: r.configId, businessDate: D, status: "closed", closedAt: new Date() });
    await db.update(reconRuns).set({ dateFrom: D1 }).where(eq(reconRuns.id, x.runId));
    const closed = await rolled();
    expect([closed.status, closed.error]).toEqual(["failed", `Business date ${D} is closed, so what these runs did there stays. Nothing was changed.`]);
    expect([await groupsOf(r.configId), await itemsOf(r.configId), (await getRun(r.configId, x.runId)).rolledBackAt]).toEqual([groups, items, null]);
    await db.delete(reconDays).where(eq(reconDays.configId, r.configId));

    // a change of a member waiting for a decision
    const [member] = await db.select({ id: reconItems.id }).from(reconItems).where(and(eq(reconItems.configId, r.configId), eq(reconItems.recordId, a1!)));
    await db.insert(approvalRequests).values({ id: Bun.randomUUIDv7(), spaceId: A, configId: r.configId, kind: "unmatch", itemId: member!.id, label: "R1", note: "n" });
    const held = await rolled();
    expect([held.status, held.error]).toEqual(["failed", "A change of an item these runs matched or broke waits for a decision. Decide or cancel it, then roll back again. Nothing was changed."]);
    expect([await groupsOf(r.configId), await itemsOf(r.configId), (await getRun(r.configId, x.runId)).rolledBackAt]).toEqual([groups, items, null]);
  }, 60_000);
});
