// One-way recons (direction a_to_b, docs/superpowers/specs/2026-11-24-one-way-recon-design.md): side A behaves as in a
// two-way recon; a side-B item with no counterpart is `not_required` at grace and day close, never an unmatch. It stays
// a candidate for a later side-A item within carry over; a near miss with a side-B item stays an unmatch. Not-required
// items are left out of the Unmatch list and its counts, the nav count, the day's counters and sign-off, the dashboard;
// Operation result shows them as "Not required". A draft's simulation projects them under that reason.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { BreakRowDto } from "@starterkit/shared/contracts/breaks";
import type { Page } from "@starterkit/shared/contracts/common";
import type { ReconDashboardDto } from "@starterkit/shared/contracts/dashboard";
import type { NavCountsDto, SignoffRowDto } from "@starterkit/shared/contracts/recon";
import type { ResultCountsDto, ResultRowDto } from "@starterkit/shared/contracts/results";
import { and, asc, eq, sql } from "drizzle-orm";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { appRoleDb } from "../../../../../test/helpers/app-role";
import { db } from "../../../../kernel/db";
import { ensureMonthPartitions } from "../../../../kernel/partitions";
import { records, sourceCursors } from "../../../ingest";
import { reconConfigVersions } from "../../../recon";
import { calendars } from "../../../sources";
import { spaces, withSpace } from "../../../spaces";
import { closeDay, sweepClosed } from "../../breaks";
import { reconDays, reconItems } from "../../schema";
import { classifyUnmatched, runRecon } from "../../service";
import { recomputeDayStats } from "../../stats";
import { ccyEq, D, D1, makeSource, plainSource, put, recon, spec, type Src, U } from "../fixtures";

type Probe = Awaited<ReturnType<typeof appRoleDb>>;
let probe: Probe, A: string, token: string;

const at = (s: string) => new Date(`${s}+07:00`);
const after = at("2026-12-01T00:00:00");
const exact = { no: 1, name: "Exact", cardinality: "1:1", blocking: [], accept: "auto", on_ambiguous: "break", predicates: [{ op: "eq", field: "ext_ref" }, { op: "eq", field: "amount_minor" }, ccyEq] };
const tolerance = { no: 2, name: "Tolerance", cardinality: "1:1", blocking: ["ext_ref"], accept: "suggest", on_ambiguous: "suggest", predicates: [{ op: "amount_abs_tol", field: "amount_minor", tolerance: { IDR: "1.00" } }, ccyEq] };
const oneWay = (a: string, b: string, passes: unknown[] = [exact], carry = 1) => ({ ...spec(a, b, passes, carry), direction: "a_to_b" });
const complete = (s: Src, t: Date) => db.insert(sourceCursors).values({ spaceId: s.spaceId, sourceId: s.sourceId, completeThrough: t })
  .onConflictDoUpdate({ target: [sourceCursors.spaceId, sourceCursors.sourceId], set: { completeThrough: t } });
const itemsOf = (configId: string) => db.select({ id: reconItems.id, side: reconItems.side, status: reconItems.status, reason: reconItems.breakReason, ref: records.extRef, date: reconItems.businessDate, resolution: reconItems.resolution })
  .from(reconItems).innerJoin(records, and(eq(records.id, reconItems.recordId), eq(records.businessDate, reconItems.businessDate)))
  .where(and(eq(reconItems.configId, configId), sql`${reconItems.simRunId} is null`)).orderBy(asc(records.extRef), asc(reconItems.side), asc(reconItems.businessDate));
const json = async <T>(r: Promise<Response>) => (await (await r).json()) as T;

async function sides(): Promise<[Src, Src]> {
  const s = [await makeSource(A, plainSource()), await makeSource(A, plainSource())] as [Src, Src];
  for (const x of s) await complete(x, after);
  return s;
}

/**
 * Day D of a recon: A1 pairs; A2 (side A) and B9 (side B) have no counterpart; AD differs by amount (a near miss with
 * side B); DU is doubled on side A (a Duplicate with one side-B item).
 */
async function dayD(direction: "a_to_b" | "two_way") {
  const [sa, sb] = await sides();
  const r = await recon(A, { ...spec(sa.sourceId, sb.sourceId, [exact], 1), direction });
  await put(sa, [{ ref: "A1", amount: 100n }, { ref: "A2", amount: 100n }, { ref: "AD", amount: 100n }, { ref: "DU", amount: 50n }, { ref: "DU", amount: 50n }]);
  await put(sb, [{ ref: "A1", amount: 100n }, { ref: "B9", amount: 50n }, { ref: "AD", amount: 300n }, { ref: "DU", amount: 50n }]);
  await runRecon(probe, { ...r, mode: "daily", from: D });
  expect(await closeDay(probe, r, D, after)).toBe("closed");
  return { r, sa, sb };
}

beforeAll(async () => {
  probe = await appRoleDb();
  await resetData();
  await db.delete(spaces);
  await db.insert(calendars).values({ id: Bun.randomUUIDv7(), code: "id-default", name: "Default", weekend: [6, 7], holidays: [] }).onConflictDoNothing();
  await db.transaction((tx) => ensureMonthPartitions(tx, records, new Date(`${D}T00:00:00Z`), 2));
  token = await signIn("superadmin");
}, 60_000);
beforeEach(async () => {
  await db.update(spaces).set({ status: "archived" });
  A = Bun.randomUUIDv7();
  await db.insert(spaces).values({ id: A, code: `s${A.slice(-8)}`, name: "Treasury" });
});
afterAll(async () => {
  await probe.$client.close();
});

describe("one-way recon (a_to_b)", () => {
  it("day close: side A without a counterpart is an unmatch; side B is not required; a near miss or a Duplicate with side B stays an unmatch", async () => {
    const { r } = await dayD("a_to_b");
    expect((await itemsOf(r.configId)).map((i) => [i.ref, i.side, i.status, i.reason])).toEqual([
      ["A1", "a", "matched", null], ["A1", "b", "matched", null], ["A2", "a", "break", "No counterpart"],
      ["AD", "a", "break", "Amount differs"], ["AD", "b", "break", "Amount differs"],
      ["B9", "b", "not_required", null],
      ["DU", "a", "break", "Duplicate"], ["DU", "a", "break", "Duplicate"], ["DU", "b", "break", "Duplicate"],
    ]);
    // the day's counters count the unmatch its close made: A2 and the AD pair, never B9
    expect((await db.select({ c: reconDays.counters }).from(reconDays).where(eq(reconDays.configId, r.configId)))[0]!.c).toEqual({ open: 3, suggested: 0 });
  }, 60_000);

  it("two-way is unchanged: the same side-B item breaks as No counterpart", async () => {
    const { r } = await dayD("two_way");
    expect((await itemsOf(r.configId)).filter((i) => i.ref === "B9").map((i) => [i.status, i.reason])).toEqual([["break", "No counterpart"]]);
  }, 60_000);

  it("Unmatch list, its summary, the nav count, sign-off and the dashboard leave not-required items out; Operation result shows them", async () => {
    const { r } = await dayD("a_to_b");
    const breaks = await json<Page<BreakRowDto>>(call("GET", `/v1/spaces/${A}/breaks?pageSize=100`, { token }));
    expect(breaks.total).toBe(6);
    expect(breaks.items.map((b) => b.ref)).not.toContain("B9");
    expect((await json<{ open: number }>(call("GET", `/v1/spaces/${A}/breaks/summary`, { token }))).open).toBe(6);
    expect((await json<NavCountsDto>(call("GET", `/v1/spaces/${A}/nav-counts`, { token }))).unmatch).toBe(6);

    const counts = await json<ResultCountsDto>(call("GET", `/v1/spaces/${A}/recons/${r.configId}/results/counts?dateFrom=${D}&dateTo=${D}`, { token }));
    expect(counts.counts).toEqual({ matched: 1, unmatch: 6, not_required: 1 });
    expect(counts.sideB.not_required).toBe(1);
    const rows = await json<Page<ResultRowDto>>(call("GET", `/v1/spaces/${A}/recons/${r.configId}/results?dateFrom=${D}&dateTo=${D}&result=not_required`, { token }));
    expect(rows.items.map((x) => [x.status, x.a.state, x.b.state, x.openItemId])).toEqual([["not_required", "none", "not_required", null]]);

    const [day] = (await json<Page<SignoffRowDto>>(call("GET", `/v1/spaces/${A}/recons/${r.configId}/signoffs`, { token }))).items;
    expect(day).toMatchObject({ openBreaks: 3, blocked: null });
    expect((await call("POST", `/v1/spaces/${A}/recons/${r.configId}/signoffs/prepare`, { token, body: { date: D } })).status).toBe(200);

    await withSpace({ spaceIds: [A], userId: null }, (tx) => recomputeDayStats(tx, A, r.configId, D));
    const dash = await json<ReconDashboardDto>(call("GET", `/v1/dashboard/recon?space=${A}&from=${D}&to=${D}`, { token }));
    expect(dash.open.count).toBe(6);
    expect(dash.open.broke).toBe(6);
    // the auto-match rate's records: side A's 5 and the 4 side-B records of a pair or an unmatch, not B9
    expect(dash.autoRate).toMatchObject({ matched: 2, records: 8 });
  }, 60_000);

  it("a side-A item of a later date within carry over pairs a not-required side-B item", async () => {
    const { r, sa } = await dayD("a_to_b");
    await put(sa, [{ ref: "B9", amount: 50n, date: D1 }]);
    await runRecon(probe, { ...r, mode: "daily", from: D1 });
    expect((await itemsOf(r.configId)).filter((i) => i.ref === "B9").map((i) => [i.side, i.date, i.status, i.resolution])).toEqual([
      ["a", D1, "matched", null], ["b", D, "matched", null],
    ]);
  }, 60_000);

  it("a pass's Duplicate that breaks a not-required item of a closed date counts on that date's open counter", async () => {
    const { r, sa } = await dayD("a_to_b");
    await put(sa, [{ ref: "B9", amount: 50n, date: D1 }, { ref: "B9", amount: 50n, date: D1 }]);
    await runRecon(probe, { ...r, mode: "daily", from: D1 });
    expect((await itemsOf(r.configId)).filter((i) => i.ref === "B9").map((i) => [i.side, i.status, i.reason])).toEqual([
      ["a", "break", "Duplicate"], ["a", "break", "Duplicate"], ["b", "break", "Duplicate"],
    ]);
    const [day] = await db.select({ c: reconDays.counters }).from(reconDays).where(and(eq(reconDays.configId, r.configId), eq(reconDays.businessDate, D)));
    expect(day!.c).toEqual({ open: 4, suggested: 0 });
  }, 60_000);

  it("carry over 0: a not-required item never meets a later date", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, oneWay(sa.sourceId, sb.sourceId, [exact], 0));
    await put(sb, [{ ref: "K1", amount: 10n }]);
    await runRecon(probe, { ...r, mode: "daily", from: D });
    expect(await closeDay(probe, r, D, after)).toBe("closed");
    await put(sa, [{ ref: "K1", amount: 10n, date: D1 }]);
    await runRecon(probe, { ...r, mode: "daily", from: D1 });
    expect((await itemsOf(r.configId)).map((i) => [i.side, i.status])).toEqual([["a", "open"], ["b", "not_required"]]);
  }, 60_000);

  it("a suggesting pass may suggest a not-required item; a person can match a side-A unmatch with one", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, oneWay(sa.sourceId, sb.sourceId, [exact, tolerance], 1));
    await put(sb, [{ ref: "S1", amount: 100n }, { ref: "M1", amount: 70n }]);
    await runRecon(probe, { ...r, mode: "daily", from: D });
    expect(await closeDay(probe, r, D, after)).toBe("closed");
    await put(sa, [{ ref: "S1", amount: 150n, date: D1 }]);
    await runRecon(probe, { ...r, mode: "daily", from: D1 });
    expect((await itemsOf(r.configId)).filter((i) => i.ref === "S1").map((i) => [i.side, i.status])).toEqual([["a", "suggested"], ["b", "suggested"]]);
    // a side-A unmatch on D1 matched by hand with the not-required M1 of D
    await put(sa, [{ ref: "X1", amount: 70n, date: D1 }]);
    await runRecon(probe, { ...r, mode: "daily", from: D1 });
    expect(await closeDay(probe, r, D1, after)).toBe("closed");
    const a = (await itemsOf(r.configId)).find((i) => i.ref === "X1")!, m = (await itemsOf(r.configId)).find((i) => i.ref === "M1")!;
    expect([a.status, m.status]).toEqual(["break", "not_required"]);
    const cands = await json<Page<{ id: string }>>(call("GET", `/v1/spaces/${A}/breaks/${a.id}/candidates`, { token }));
    expect(cands.items.map((c) => c.id)).toContain(m.id);
    expect((await call("POST", `/v1/spaces/${A}/breaks/${a.id}/match`, { token, body: { itemIds: [m.id] } })).status).toBe(200);
    expect((await itemsOf(r.configId)).filter((i) => i.ref === "M1" || i.ref === "X1").map((i) => i.status)).toEqual(["matched", "matched"]);
  }, 60_000);

  it("grace: a side-B item past grace with no counterpart is not required; side A's breaks", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, oneWay(sa.sourceId, sb.sourceId));
    await put(sa, [{ ref: "G1", amount: 10n, et: `${D}T09:00:00+07:00` }]);
    await put(sb, [{ ref: "G2", amount: 10n, et: `${D}T09:00:00+07:00` }]);
    await runRecon(probe, { ...r, mode: "daily", from: D });
    expect((await itemsOf(r.configId)).map((i) => [i.ref, i.status, i.reason])).toEqual([["G1", "break", "No counterpart"], ["G2", "not_required", null]]);
  }, 60_000);

  it("a tie a suggesting pass settles with one side-B item: the other side-B item of that reference stays an unmatch", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, oneWay(sa.sourceId, sb.sourceId, [{ ...exact, on_ambiguous: "suggest" }]));
    await put(sa, [{ ref: "T1", amount: 10n }]);
    await put(sb, [{ ref: "T1", amount: 10n }, { ref: "T1", amount: 10n }]);
    await runRecon(probe, { ...r, mode: "daily", from: D });
    expect(await closeDay(probe, r, D, after)).toBe("closed");
    expect((await itemsOf(r.configId)).filter((i) => i.side === "b").map((i) => i.status)).toEqual(["break", "break"]);
  }, 60_000);

  it("a second side-B item of a reference side A already matched is an unmatch (a double settlement), not not required", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, oneWay(sa.sourceId, sb.sourceId));
    await put(sa, [{ ref: "W1", amount: 10n }]);
    await put(sb, [{ ref: "W1", amount: 10n }]);
    await runRecon(probe, { ...r, mode: "daily", from: D });
    await put(sb, [{ ref: "W1", amount: 10n }]);
    await runRecon(probe, { ...r, mode: "daily", from: D });
    expect(await closeDay(probe, r, D, after)).toBe("closed");
    expect((await itemsOf(r.configId)).map((i) => [i.side, i.status]).sort()).toEqual([["a", "matched"], ["b", "break"], ["b", "matched"]]);
  }, 60_000);

  it("publishing a two-way version opens the not-required items again; the next sweep breaks them as No counterpart", async () => {
    const { r, sa, sb } = await dayD("a_to_b");
    const v2 = Bun.randomUUIDv7();
    await db.insert(reconConfigVersions).values({ id: v2, configId: r.configId, spaceId: A, version: 2, status: "in_review", spec: spec(sa.sourceId, sb.sourceId, [exact], 1), specHash: "h2", matchingHash: "h2", makerId: U });
    expect((await call("POST", `/v1/spaces/${A}/recons/${r.configId}/versions/${v2}/approve`, { token })).status).toBe(200);
    expect((await itemsOf(r.configId)).filter((i) => i.ref === "B9").map((i) => i.status)).toEqual(["open"]);
    const acts = await json<Page<{ action: string; after: { reopened?: number } | null }>>(call("GET", `/v1/spaces/${A}/recons/${r.configId}/activity`, { token }));
    expect(acts.items.find((e) => e.action === "recon.version_approve")?.after?.reopened).toBe(1);
    await sweepClosed(probe, r, D, D);
    expect((await itemsOf(r.configId)).filter((i) => i.ref === "B9").map((i) => [i.status, i.reason])).toEqual([["break", "No counterpart"]]);
  }, 60_000);

  it("a draft's simulation projects side B's items without a counterpart as Not required", async () => {
    const [sa, sb] = await sides();
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [exact], 1));
    await put(sa, [{ ref: "P1", amount: 10n }]);
    await put(sb, [{ ref: "P2", amount: 10n }]);
    const draft = Bun.randomUUIDv7();
    await db.insert(reconConfigVersions).values({ id: draft, configId: r.configId, spaceId: A, version: 2, status: "draft", spec: oneWay(sa.sourceId, sb.sourceId), specHash: "h2", matchingHash: "h2", makerId: U });
    const sim = await runRecon(probe, { ...r, versionId: draft, mode: "simulation", from: D });
    const projected = await withSpace({ spaceIds: [A], userId: null }, (tx) => classifyUnmatched(tx, { ...r, versionId: draft, simRunId: sim.runId, from: D, to: D }), probe);
    expect(projected.map((x) => [x.side, x.reason])).toEqual([["a", "No counterpart"], ["b", "Not required"]]);
  }, 60_000);
});
