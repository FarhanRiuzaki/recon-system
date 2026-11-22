// The engine end to end as the app role (appRoleDb: row level security on, as the worker's workerDb):
// - The Plan 3 gate (docs/recon/source-test-db.md "Kunci jawaban config gerbang Plan 3"): recon_source_test's tables
//   built in <test database>_src by the same seed SQL (scripts/source-test-seed.ts), pulled through the ingest pipeline
//   (ingest.pull handler, the gate mapping with amount unit minor), the gate config run over 2–5 Nov 2026; every
//   outcome per reference and the per-date strip. A rerun changes nothing (Focus 3); a simulation touches no live item.
// - Competing candidates on a tolerance pass (Focus 2), a held item (A1), a settlement on D+1 (A3), KSEI S10
//   (Duplicate) and a shared source (Focus 4, DEC-042), on records written directly.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { SourceSpec } from "@starterkit/shared/contracts/sources";
import type { SQL } from "bun";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { sourceTestTables } from "../../../../../scripts/source-test-seed";
import { appRoleDb } from "../../../../../test/helpers/app-role";
import { holdTx, truncateAll } from "../../../../../test/helpers/db";
import { sourceDb } from "../../../../../test/helpers/source-db";
import { db } from "../../../../kernel/db";
import { QUEUES } from "../../../../kernel/jobs";
import { ensureMonthPartitions } from "../../../../kernel/partitions";
import { ingestHandlers, records } from "../../../ingest";
import { reconConfigVersions } from "../../../recon";
import { calendars, sourceShares } from "../../../sources";
import { matchGroups, matchMembers, reconDays, reconItems, reconRuns } from "../../schema";
import { closeDay } from "../../breaks";
import { classifyUnmatched, runRecon } from "../../service";
import { spaces, withSpace } from "../../../spaces";
import { ccyEq, D, D1, gateSource, gateSpec, makeSource, plainSource, put, range, recon, ref, spec, U } from "../fixtures";

type Probe = Awaited<ReturnType<typeof appRoleDb>>;
let probe: Probe, src: SQL, secret: Awaited<ReturnType<typeof sourceDb>>["secret"];
const A = Bun.randomUUIDv7(), B = Bun.randomUUIDv7();

/** A source of `spaceId` with version 1 published, connected to `<test>_src` (sourceDb). */
const source = (spaceId: string, spec: SourceSpec) => makeSource(spaceId, spec, secret);

/** Every live item of `configId` with its record's reference. */
const itemsOf = (configId: string) => db.select({ id: reconItems.id, side: reconItems.side, status: reconItems.status, reason: reconItems.breakReason, date: reconItems.businessDate, version: reconItems.version, ref: records.extRef })
  .from(reconItems).innerJoin(records, and(eq(records.id, reconItems.recordId), eq(records.businessDate, reconItems.businessDate)))
  .where(and(eq(reconItems.configId, configId), sql`${reconItems.simRunId} is null`)).orderBy(asc(records.extRef), asc(reconItems.side), asc(reconItems.id));
/** Every live group of `configId` (or of run `runId`) with its members' references, accounts, sides and amounts. */
async function groupsOf(configId: string, runId?: string) {
  const rows = await db.select({ id: matchGroups.id, pass: matchGroups.passNo, kind: matchGroups.kind, date: matchGroups.businessDate, evidence: matchGroups.evidence, side: matchMembers.side, ref: records.extRef, acct: records.accountRef, amount: matchMembers.signedAmount })
    .from(matchGroups).innerJoin(matchMembers, eq(matchMembers.groupId, matchGroups.id)).innerJoin(reconItems, eq(reconItems.id, matchMembers.itemId))
    .innerJoin(records, and(eq(records.id, reconItems.recordId), eq(records.businessDate, reconItems.businessDate)))
    .where(and(eq(matchGroups.configId, configId), runId ? eq(matchGroups.runId, runId) : sql`${matchGroups.simRunId} is null`))
    .orderBy(asc(matchGroups.id), asc(matchMembers.side), asc(records.accountRef));
  const by = new Map<string, { pass: number; kind: string; date: string; evidence: unknown; refs: string[]; accts: string[]; sides: string[]; amounts: (bigint | null)[] }>();
  for (const r of rows) {
    const g = by.get(r.id) ?? { pass: r.pass, kind: r.kind, date: r.date, evidence: r.evidence, refs: [], accts: [], sides: [], amounts: [] };
    g.refs.push(r.ref!); g.accts.push(r.acct ?? ""); g.sides.push(r.side); g.amounts.push(r.amount);
    by.set(r.id, g);
  }
  return [...by.values()];
}
const refsOf = (gs: { refs: string[] }[]) => [...new Set(gs.flatMap((g) => g.refs))].sort();
/** A run's per-side count; a 1:1 pass's counters (its items per side follow from its groups; broken split evenly). */
const side = (a: number, b = a) => ({ a, b });
const pass = (matched: number, suggested: number, broken: number, brokenRefs: number) => ({
  matched, suggested, broken, brokenRefs, matchedItems: side(matched), suggestedItems: side(suggested), brokenItems: side(broken / 2),
});

describe("the Plan 3 gate: source1 vs source2 of recon_source_test, 2–5 Nov 2026", () => {
  let gate: Awaited<ReturnType<typeof recon>>;
  let firstRun: string, gateSides: [string, string];
  beforeAll(async () => {
    await truncateAll();
    await db.insert(spaces).values([{ id: A, code: "a", name: "A" }, { id: B, code: "b", name: "B" }]);
    await db.insert(calendars).values({ id: Bun.randomUUIDv7(), code: "id-default", name: "Default", weekend: [6, 7], holidays: [] });
    await src.unsafe("create schema if not exists core");
    await src.begin((tx) => tx.unsafe(sourceTestTables()));
    const [s1, s2] = [await source(A, gateSource(1)), await source(A, gateSource(2))];
    const pull = ingestHandlers(probe)[QUEUES.ingestPull]!;
    for (const s of [s1, s2]) await pull({ id: "t", data: { spaceId: s.spaceId, sourceId: s.sourceId } });
    const n = await db.select({ s: records.sourceId, n: sql<number>`count(*)::int` }).from(records).groupBy(records.sourceId);
    expect(n.map((x) => x.n)).toEqual([1000, 1000]);
    gateSides = [s1.sourceId, s2.sourceId];
    gate = await recon(A, gateSpec(...gateSides));
  }, 60_000);

  it("matches the answer key per reference and per date", async () => {
    const t0 = performance.now();
    const run = await runRecon(probe, { ...gate, mode: "manual", from: "2026-11-02", to: "2026-11-05" });
    console.log(`gate run 2–5 Nov: ${Math.round(performance.now() - t0)} ms`);
    firstRun = run.runId;
    expect(run.counters).toEqual({
      intake: side(1000), replaced: side(0), passes: { 1: pass(937, 0, 30, 10), 2: pass(0, 14, 0, 0), 3: pass(0, 10, 0, 0) }, open: side(24),
    });

    const groups = await groupsOf(gate.configId);
    const auto = groups.filter((g) => g.kind === "auto"), p2 = groups.filter((g) => g.pass === 2), p3 = groups.filter((g) => g.pass === 3);
    expect([auto.length, p2.length, p3.length, groups.length]).toEqual([937, 14, 10, 961]);
    expect(auto.every((g) => g.pass === 1 && g.refs[0] === g.refs[1] && g.sides.join() === "a,b")).toBe(true);
    expect(refsOf(auto)).toEqual(range(1, 940, [931, 932, 933]));
    expect(p2.every((g) => g.kind === "suggested" && g.refs[0] === g.refs[1] && g.amounts[1]! - g.amounts[0]! === 50000n)).toBe(true);
    expect(refsOf(p2)).toEqual(range(941, 955, [950]));
    expect(p3.every((g) => g.kind === "suggested" && g.refs[0] === g.refs[1])).toBe(true);
    expect(refsOf(p3)).toEqual(range(956, 965));
    // evidence: per predicate passed + delta, how the pair was chosen, the version and run
    expect(p2[0]!.evidence).toMatchObject({
      pass: 2, name: "Amount tolerance", configVersionId: gate.versionId, runId: run.runId, chosen: "mutual unique best",
      predicates: [{ op: "amount_abs_tol", field: "amount_minor", passed: true, delta: 50000 }, { op: "eq", field: "currency", passed: true, delta: null }],
    });
    expect(p3[0]!.evidence).toMatchObject({ predicates: [{ op: "eq", delta: null }, { op: "date_window", delta: 1 }, { op: "eq" }] });

    const items = await itemsOf(gate.configId);
    const dup = items.filter((i) => i.status === "break");
    expect([dup.length, new Set(dup.map((i) => i.reason)).size, dup[0]?.reason]).toEqual([30, 1, "Duplicate"]);
    expect([...new Set(dup.map((i) => i.ref))].sort()).toEqual(range(966, 975));
    const open = (side: string) => items.filter((i) => i.status === "open" && i.side === side).map((i) => i.ref).sort();
    expect(open("a")).toEqual([...range(931, 933), ref(950), ...range(976, 995)]);
    expect(open("b")).toEqual([...range(931, 933), ref(950), ...range(996, 1015)]);
    expect(items.filter((i) => i.status === "suggested").length).toBe(48);

    // the per-date strip: a group on its latest member's date, an item without a pair on its own
    const strip = ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"].map((d) => [
      d, auto.filter((g) => g.date === d).length, [...p2, ...p3].filter((g) => g.date === d).length,
      items.filter((i) => i.status === "open" && i.side === "a" && i.date === d).length, items.filter((i) => i.status === "open" && i.side === "b" && i.date === d).length,
      dup.filter((i) => i.date === d).length,
    ]);
    expect(strip).toEqual([
      ["2026-11-02", 312, 5, 7, 8, 12],
      ["2026-11-03", 313, 8, 8, 8, 9],
      ["2026-11-04", 312, 7, 9, 8, 9],
      ["2026-11-05", 0, 4, 0, 0, 0],
    ]);
    expect((await db.select({ status: reconRuns.status }).from(reconRuns).where(eq(reconRuns.id, run.runId)))[0]!.status).toBe("succeeded");
  }, 60_000);

  it("the near-miss classifier: per side 3 currency differs, 1 amount differs, 20 without counterpart; reads only", async () => {
    const before = await itemsOf(gate.configId);
    const rows = await withSpace({ spaceIds: [A], userId: null }, (tx) => classifyUnmatched(tx, { ...gate, simRunId: null, from: "2026-11-02", to: "2026-11-05" }), probe);
    const refOf = new Map(before.map((i) => [i.id, i.ref]));
    const per = (side: string, reason: string) => rows.filter((r) => r.side === side && r.reason === reason).map((r) => refOf.get(r.itemId)).sort();
    for (const [side, only] of [["a", range(976, 995)], ["b", range(996, 1015)]] as const) {
      expect(per(side, "Currency differs")).toEqual(range(931, 933));
      expect(per(side, "Amount differs")).toEqual([ref(950)]);
      expect(per(side, "No counterpart")).toEqual(only);
      expect(rows.filter((r) => r.side === side).length).toBe(24);
    }
    // a near pair is the same reference on the other side; no pair without a counterpart
    expect(rows.every((r) => (r.reason === "No counterpart") === (r.pairItemId === null))).toBe(true);
    expect(rows.filter((r) => r.pairItemId).every((r) => refOf.get(r.pairItemId!) === refOf.get(r.itemId) && before.find((i) => i.id === r.pairItemId)!.side !== r.side)).toBe(true);
    expect(rows.find((r) => refOf.get(r.itemId) === ref(976))?.businessDate).toBe(before.find((i) => i.ref === ref(976))!.date);
    expect(await itemsOf(gate.configId)).toEqual(before);
  }, 60_000);

  it("Focus 3: the same run again changes nothing (no group, no item moved)", async () => {
    const before = [await itemsOf(gate.configId), await groupsOf(gate.configId)];
    const again = await runRecon(probe, { ...gate, mode: "rerun", from: "2026-11-02", to: "2026-11-05" });
    expect(again.counters).toEqual({
      intake: side(0), replaced: side(0), passes: { 1: pass(0, 0, 0, 0), 2: pass(0, 0, 0, 0), 3: pass(0, 0, 0, 0) }, open: side(24),
    });
    expect([await itemsOf(gate.configId), await groupsOf(gate.configId)]).toEqual(before);
    expect((await groupsOf(gate.configId, firstRun)).length).toBe(961);
  }, 60_000);

  it("a simulation of a draft gives the same answer in its own rows and touches no live item", async () => {
    const live = [await itemsOf(gate.configId), await groupsOf(gate.configId)];
    const draft = Bun.randomUUIDv7();
    await db.insert(reconConfigVersions).values({ id: draft, configId: gate.configId, spaceId: A, version: 2, status: "draft", spec: gateSpec(...gateSides), specHash: "h2", matchingHash: "h2", makerId: U });
    const sim = await runRecon(probe, { ...gate, versionId: draft, mode: "simulation", from: "2026-11-02", to: "2026-11-05" });
    expect(sim.counters.passes).toEqual({ 1: pass(937, 0, 30, 10), 2: pass(0, 14, 0, 0), 3: pass(0, 10, 0, 0) });
    expect((await groupsOf(gate.configId, sim.runId)).length).toBe(961);
    expect((await db.select({ n: sql<number>`count(*)::int` }).from(reconItems).where(eq(reconItems.simRunId, sim.runId)))[0]!.n).toBe(2000);
    expect([await itemsOf(gate.configId), await groupsOf(gate.configId)]).toEqual(live);
    // the near-miss classifier gives the simulation's open items the same reasons and pairs as the live ones
    const classify = (versionId: string, simRunId: string | null) => withSpace({ spaceIds: [A], userId: null },
      (tx) => classifyUnmatched(tx, { ...gate, versionId, simRunId, from: "2026-11-02", to: "2026-11-05" }), probe);
    const byRecord = async (rows: Awaited<ReturnType<typeof classify>>) => {
      const rec = new Map((await db.select({ id: reconItems.id, rid: reconItems.recordId }).from(reconItems).where(eq(reconItems.configId, gate.configId))).map((x) => [x.id, x.rid]));
      return rows.map((r) => [rec.get(r.itemId), r.side, r.businessDate, r.reason, r.pairItemId && rec.get(r.pairItemId)]).sort((x, y) => String(x[0]).localeCompare(String(y[0])));
    };
    expect(await byRecord(await classify(draft, sim.runId))).toEqual(await byRecord(await classify(gate.versionId, null)));
    // a draft never runs live
    const e = await runRecon(probe, { ...gate, versionId: draft, mode: "manual", from: "2026-11-02" }).catch((x: unknown) => x);
    expect((e as Error).message).toBe("Only the published version of a recon runs.");
  }, 60_000);
  it("Focus 6: day close turns 24 suggested pairs into breaks with their pass's reason (pairs kept) and 48 open items into breaks with the classifier's", async () => {
    const after = new Date("2026-12-31T00:00:00+07:00"); // past every close moment and its grace
    const closed = [];
    for (const d of ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"]) closed.push(await closeDay(probe, gate, d, after));
    expect(closed).toEqual(["closed", "closed", "closed", "closed"]);
    expect(await closeDay(probe, gate, "2026-11-05", after)).toBe("already");
    const days = await db.select().from(reconDays).where(eq(reconDays.configId, gate.configId)).orderBy(asc(reconDays.businessDate));
    expect(days.map((d) => d.status)).toEqual(["closed", "closed", "closed", "closed"]);
    const sum = (k: "open" | "suggested") => days.reduce((n, d) => n + (d.counters as Record<string, number>)[k]!, 0);
    expect([sum("open"), sum("suggested")]).toEqual([48, 48]);
    const items = await db.select({ status: reconItems.status, reason: reconItems.breakReason, late: reconItems.lateMatch, ref: records.extRef, side: reconItems.side })
      .from(reconItems).innerJoin(records, and(eq(records.id, reconItems.recordId), eq(records.businessDate, reconItems.businessDate)))
      .where(and(eq(reconItems.configId, gate.configId), sql`${reconItems.simRunId} is null`));
    expect(items.filter((i) => i.status === "open" || i.status === "suggested").length).toBe(0);
    const by = (reason: string, late: boolean) => items.filter((i) => i.status === "break" && i.reason === reason && i.late === late).map((i) => `${i.side}${i.ref!.slice(-4)}`).sort();
    expect(by("Amount differs", false).filter((x) => !x.endsWith("0950")).length).toBe(28); // pass 2, 14 pairs
    expect(by("Date differs", false).length).toBe(20); // pass 3, 10 pairs
    // a near miss keeps its pair for a person; only "No counterpart" rejoins the pool across days (DEC-047)
    expect(by("Currency differs", false)).toEqual(["a0931", "a0932", "a0933", "b0931", "b0932", "b0933"]);
    expect(by("Amount differs", false).filter((x) => x.endsWith("0950"))).toEqual(["a0950", "b0950"]);
    expect(by("No counterpart", true).length).toBe(40);
    expect(by("Duplicate", false).length).toBe(30); // the run's own breaks, untouched
    // the suggested pairs stay as the resolution to accept in one click
    const kept = await db.select({ n: sql<number>`count(*)::int` }).from(matchGroups)
      .where(and(eq(matchGroups.configId, gate.configId), sql`${matchGroups.simRunId} is null`, eq(matchGroups.kind, "suggested"), sql`${matchGroups.reversedBy} is null`));
    expect(kept[0]!.n).toBe(24);
  }, 60_000);
});

// ------------------------------------------------------------------------------------------------ records written directly

describe("cases on records written directly", () => {
  beforeEach(async () => {
    await truncateAll();
    await db.insert(spaces).values([{ id: A, code: "a", name: "A" }, { id: B, code: "b", name: "B" }]);
    await db.transaction((tx) => ensureMonthPartitions(tx, records, new Date(`${D}T00:00:00Z`), 1));
  });

  it("Focus 2: competing candidates on a tolerance pass never give a wrong pair; a tie is only suggested", async () => {
    const [sa, sb] = [await source(A, plainSource()), await source(A, plainSource())];
    // K1: b1 is closer to a2 (100) than to a1 (400); a greedy pass in A's order would pair a1–b1. K2: b2 and b3 tie for a3.
    await put(sa, [{ ref: "K1", amount: 1_000_000n }, { ref: "K1", amount: 1_000_500n }, { ref: "K2", amount: 500_000n }]);
    await put(sb, [{ ref: "K1", amount: 1_000_400n }, { ref: "K2", amount: 500_100n }, { ref: "K2", amount: 499_900n }]);
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [
      { no: 1, name: "Tolerance", cardinality: "1:1", blocking: ["ext_ref"], accept: "auto", on_ambiguous: "suggest",
        predicates: [{ op: "amount_abs_tol", field: "amount_minor", tolerance: { IDR: "1000.00" } }, ccyEq] },
    ]));
    const run = await runRecon(probe, { ...r, mode: "manual", from: D });
    expect(run.counters.passes).toMatchObject({ 1: { matched: 1, suggested: 1, broken: 0 } });
    const groups = await groupsOf(r.configId);
    const auto = groups.find((g) => g.kind === "auto")!;
    expect([auto.refs, auto.amounts]).toEqual([["K1", "K1"], [1_000_500n, 1_000_400n]]);
    const tie = groups.find((g) => g.kind === "suggested")!;
    expect([tie.refs, tie.amounts[0]]).toEqual([["K2", "K2"], 500_000n]);
    expect(tie.evidence).toMatchObject({ chosen: "tie broken by business date, event time, record id" });
    const open = (await itemsOf(r.configId)).filter((i) => i.status === "open");
    expect(open.map((i) => [i.ref, i.side])).toEqual([["K1", "a"], ["K2", "b"]]);
  });

  it("A1: an item another transaction holds is skipped; the run succeeds and never waits for it", async () => {
    const [sa, sb] = [await source(A, plainSource()), await source(A, plainSource())];
    await put(sa, [{ ref: "R1", amount: 100n }, { ref: "R2", amount: 200n }]);
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [gateSpec("", "").passes[0]]));
    await runRecon(probe, { ...r, mode: "manual", from: D }); // items of side A, open
    await put(sb, [{ ref: "R1", amount: 100n }, { ref: "R2", amount: 200n }]);
    const [held] = (await itemsOf(r.configId)).filter((i) => i.ref === "R1");
    // an operator's change, not committed yet: guarded by state and version, as Plan 5's actions are
    const hold = await holdTx((tx) => tx.update(reconItems).set({ status: "break", breakReason: "Held", version: sql`${reconItems.version} + 1` })
      .where(and(eq(reconItems.id, held!.id), eq(reconItems.status, "open"), eq(reconItems.version, held!.version))));
    try {
      const run = await runRecon(probe, { ...r, mode: "manual", from: D });
      expect(run.counters.passes).toMatchObject({ 1: { matched: 1, suggested: 0, broken: 0 } });
    } finally {
      await hold.commit();
    }
    expect(refsOf(await groupsOf(r.configId))).toEqual(["R2"]);
    const items = await itemsOf(r.configId);
    expect(items.filter((i) => i.ref === "R1").map((i) => [i.side, i.status, i.reason, i.version])).toEqual([["a", "break", "Held", 1], ["b", "open", null, 0]]);
    // committed meanwhile: the next run reads it as it is now and leaves it
    await runRecon(probe, { ...r, mode: "manual", from: D });
    expect((await itemsOf(r.configId)).filter((i) => i.ref === "R1").map((i) => i.status)).toEqual(["break", "open"]);
  });

  it("A3: three transactions of D and their settlement on D+1 make one N:1 group, across dates within carry over", async () => {
    const [txn, stl] = [await source(A, plainSource()), await source(A, plainSource())];
    await put(txn, [{ ref: "T1", amount: 100n, sref: "ST1" }, { ref: "T2", amount: 250n, sref: "ST1" }, { ref: "T3", amount: 650n, sref: "ST1" }, { ref: "T4", amount: 50n, sref: "ST2" }]);
    await put(stl, [{ ref: "S1", amount: 1000n, sref: "ST1", date: D1 }, { ref: "S2", amount: 60n, sref: "ST2", date: D1 }]);
    const passes = [
      { no: 1, name: "Settlement", cardinality: "N:1", blocking: ["attrs.settlement_ref"], accept: "auto", on_ambiguous: "break",
        predicates: [{ op: "eq_sum", field: "amount_minor", tolerance: {} }, ccyEq] },
    ];
    const r = await recon(A, spec(txn.sourceId, stl.sourceId, passes));
    const run = await runRecon(probe, { ...r, mode: "manual", from: D, to: D1 });
    expect(run.counters.passes).toMatchObject({ 1: { matched: 1, suggested: 0, broken: 0 } });
    const [g, ...more] = await groupsOf(r.configId);
    expect(more).toEqual([]);
    expect([g!.kind, g!.date, g!.refs.sort(), g!.sides.sort().join("")]).toEqual(["auto", D1, ["S1", "T1", "T2", "T3"], "aaab"]);
    expect(g!.evidence).toMatchObject({ chosen: "group sum, one counterpart", predicates: [{ op: "eq_sum", sum: 1000, one: 1000, delta: 0, members: 3 }, { op: "eq" }] });
    // ST2's sum is 50 against 60: it waits
    expect((await itemsOf(r.configId)).filter((i) => i.status === "open").map((i) => i.ref)).toEqual(["S2", "T4"]);
    // carry over 0: a settlement on D+1 never meets transactions of D
    const r0 = await recon(A, spec(txn.sourceId, stl.sourceId, passes, 0));
    expect((await runRecon(probe, { ...r0, mode: "manual", from: D, to: D1 })).counters.passes).toMatchObject({ 1: { matched: 0, suggested: 0, broken: 0 } });
  });

  it("KSEI S10 (ksei-sample-data.md): one KSEI row and two Medallion rows of a SID break as Duplicate; S09 and S11 wait", async () => {
    const sid = (n: number) => `TSTSID0000000${String(n).padStart(2, "0")}`;
    const [ksei, medallion] = [await source(A, plainSource()), await source(A, plainSource())];
    await put(ksei, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => ({ acct: sid(n), ref: `K${n}` })));
    await put(medallion, [1, 2, 3, 4, 5, 6, 7, 8, 11, 10, 10].map((n) => ({ acct: sid(n), ref: `M${n}` })));
    const r = await recon(A, spec(ksei.sourceId, medallion.sourceId, [
      { no: 1, name: "SID", cardinality: "1:1", blocking: [], accept: "auto", on_ambiguous: "break", predicates: [{ op: "eq", field: "account_ref" }] },
    ], 0));
    const run = await runRecon(probe, { ...r, mode: "daily", from: D });
    expect(run.counters).toMatchObject({ intake: { a: 10, b: 11 }, replaced: { a: 0, b: 0 }, passes: { 1: { matched: 8, suggested: 0, broken: 3 } }, open: { a: 1, b: 1 } });
    const items = await itemsOf(r.configId);
    expect(items.filter((i) => i.status === "break").map((i) => [i.ref, i.reason])).toEqual([["K10", "Duplicate"], ["M10", "Duplicate"], ["M10", "Duplicate"]]);
    expect(items.filter((i) => i.status === "open").map((i) => i.ref)).toEqual(["K9", "M11"]);
  });

  it("Focus 4: a recon of space B reads a source of A shared to it, never one that is not; its rows are B's", async () => {
    const shared = await source(A, plainSource()), notShared = await source(A, plainSource()), own = await source(B, plainSource());
    await db.insert(sourceShares).values({ spaceId: A, sourceId: shared.sourceId, toSpaceId: B });
    await put(shared, [{ ref: "R1", amount: 1n }, { ref: "R2", amount: 2n }]);
    await put(notShared, [{ ref: "R1", amount: 1n }]);
    await put(own, [{ ref: "R1", amount: 1n }]);
    const pass = [{ no: 1, name: "Ref", cardinality: "1:1", blocking: [], accept: "auto", on_ambiguous: "break", predicates: [{ op: "eq", field: "ext_ref" }] }];
    const ok = await recon(B, spec(shared.sourceId, own.sourceId, pass));
    const run = await runRecon(probe, { ...ok, mode: "manual", from: D });
    expect(run.counters).toMatchObject({ intake: { a: 2, b: 1 }, passes: { 1: { matched: 1 } } });
    expect(new Set((await db.select({ s: reconItems.spaceId }).from(reconItems)).map((x) => x.s))).toEqual(new Set([B]));

    const bad = await recon(B, spec(notShared.sourceId, own.sourceId, pass));
    const e = await runRecon(probe, { ...bad, mode: "manual", from: D }).catch((x: unknown) => x);
    expect((e as Error).message).toBe("Side A: this space can't read a published version of its source.");
    expect(await db.select().from(reconItems).where(eq(reconItems.configId, bad.configId))).toEqual([]);
    // the same config run as space A (the source's owner) is not found: a config is its own space's
    const other = await runRecon(probe, { ...ok, spaceId: A, mode: "manual", from: D }).catch((x: unknown) => x);
    expect((other as Error).message).toBe("This recon version doesn't exist.");
    expect((await db.select({ n: sql<number>`count(*)::int` }).from(reconRuns).where(inArray(reconRuns.configId, [ok.configId, bad.configId])))[0]!.n).toBe(1);
  });

  const exact = (o: { accept?: string; on_ambiguous?: string } = {}) => [{ no: 1, name: "Exact", cardinality: "1:1", blocking: [], accept: "auto", on_ambiguous: "break",
    predicates: [{ op: "eq", field: "ext_ref" }, { op: "eq", field: "amount_minor" }, ccyEq], ...o }];

  it("I1: duplicates of a key held as many times on both sides pair in record order (FIFO); 3:2 breaks as Duplicate", async () => {
    const [sa, sb] = [await source(A, plainSource()), await source(A, plainSource())];
    // record order = business date, event time, record id: A's second record is its first by event time
    await put(sa, [{ ref: "X", amount: 100n, acct: "a-late", et: "2026-11-02T03:05:00Z" }, { ref: "X", amount: 100n, acct: "a-early", et: "2026-11-02T03:00:00Z" }]);
    await put(sb, [{ ref: "X", amount: 100n, acct: "b-early", et: "2026-11-02T03:01:00Z" }, { ref: "X", amount: 100n, acct: "b-late", et: "2026-11-02T03:06:00Z" }]);
    await put(sa, [1, 2, 3].map(() => ({ ref: "Y", amount: 5n })));
    await put(sb, [1, 2].map(() => ({ ref: "Y", amount: 5n })));
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, exact()));
    const run = await runRecon(probe, { ...r, mode: "manual", from: D });
    expect(run.counters.passes).toMatchObject({ 1: { matched: 2, suggested: 0, broken: 5 } });
    const groups = await groupsOf(r.configId);
    expect(groups.map((g) => [g.kind, g.accts.join("+")]).sort()).toEqual([["auto", "a-early+b-early"], ["auto", "a-late+b-late"]]);
    expect(groups[0]!.evidence).toMatchObject({ chosen: "duplicates paired in order: business date, event time, record id" });
    expect((await itemsOf(r.configId)).filter((i) => i.ref === "Y").map((i) => i.reason)).toEqual(Array(5).fill("Duplicate"));
  });

  it("I2: a competitor another transaction holds still competes: nothing of its key is matched or broken until it is free", async () => {
    const [ksei, medallion] = [await source(A, plainSource()), await source(A, plainSource())];
    const r = await recon(A, spec(ksei.sourceId, medallion.sourceId, [
      { no: 1, name: "SID", cardinality: "1:1", blocking: [], accept: "auto", on_ambiguous: "break", predicates: [{ op: "eq", field: "account_ref" }] },
    ], 0));
    await put(medallion, [{ ref: "M10", acct: "SID10" }, { ref: "M10b", acct: "SID10" }]);
    await runRecon(probe, { ...r, mode: "daily", from: D });
    await put(ksei, [{ ref: "K10", acct: "SID10" }]);
    const held = (await itemsOf(r.configId)).find((i) => i.ref === "M10b")!;
    const hold = await holdTx((tx) => tx.select({ id: reconItems.id }).from(reconItems).where(eq(reconItems.id, held.id)).for("update"));
    try {
      const run = await runRecon(probe, { ...r, mode: "daily", from: D });
      expect(run.counters.passes).toMatchObject({ 1: { matched: 0, suggested: 0, broken: 0 } });
    } finally {
      await hold.rollback();
    }
    expect((await itemsOf(r.configId)).map((i) => i.status)).toEqual(["open", "open", "open"]);
    await runRecon(probe, { ...r, mode: "daily", from: D });
    expect((await itemsOf(r.configId)).map((i) => [i.ref, i.reason])).toEqual([["K10", "Duplicate"], ["M10", "Duplicate"], ["M10b", "Duplicate"]]);
  });

  it("I3: a side that negates its amounts meets the other's opposite booking; a batch nets its refund; members keep their own sign", async () => {
    const [sa, sb] = [await source(A, plainSource()), await source(A, plainSource())];
    await put(sa, [{ ref: "S", amount: 100n, dir: "debit" }]);
    await put(sb, [{ ref: "S", amount: 100n, dir: "credit" }]);
    const negated = (passes: unknown[], carry = 1) => {
      const x = spec(sa.sourceId, sb.sourceId, passes, carry);
      return { ...x, sides: [x.sides[0], { ...x.sides[1], amount_sign: "negate" }] };
    };
    const plain = await recon(A, spec(sa.sourceId, sb.sourceId, exact()));
    expect((await runRecon(probe, { ...plain, mode: "manual", from: D })).counters.passes).toMatchObject({ 1: { matched: 0, suggested: 0, broken: 0 } });
    const r = await recon(A, negated(exact()));
    expect((await runRecon(probe, { ...r, mode: "manual", from: D })).counters.passes).toMatchObject({ 1: { matched: 1, suggested: 0, broken: 0 } });
    expect((await groupsOf(r.configId))[0]!.amounts).toEqual([-100n, 100n]);

    // a batch: two credits and a refund (debit) of side A against one settlement booked as a debit on side B
    const [ta, tb] = [await source(A, plainSource()), await source(A, plainSource())];
    await put(ta, [{ ref: "T1", amount: 100n, sref: "B1" }, { ref: "T2", amount: 250n, sref: "B1" }, { ref: "R1", amount: 50n, dir: "debit", sref: "B1" }]);
    await put(tb, [{ ref: "STL", amount: 300n, dir: "debit", sref: "B1" }]);
    const batch = spec(ta.sourceId, tb.sourceId, [{ no: 1, name: "Batch", cardinality: "N:1", blocking: ["attrs.settlement_ref"], accept: "auto", on_ambiguous: "break",
      predicates: [{ op: "eq_sum", field: "amount_minor", tolerance: {} }, ccyEq] }]);
    const g = await recon(A, { ...batch, sides: [batch.sides[0], { ...batch.sides[1], amount_sign: "negate" }] });
    expect((await runRecon(probe, { ...g, mode: "manual", from: D })).counters.passes).toMatchObject({ 1: { matched: 1, suggested: 0, broken: 0 } });
    const [grp] = await groupsOf(g.configId);
    expect(grp!.amounts.map(String).sort()).toEqual(["-300", "-50", "100", "250"]);
    expect(grp!.evidence).toMatchObject({ predicates: [{ op: "eq_sum", sum: 300, one: 300, delta: 0, members: 3 }, { op: "eq" }] });
  });

  it("I6: an open item whose record was replaced closes and stops counting; the new record is a new item", async () => {
    const [sa, sb] = [await source(A, plainSource()), await source(A, plainSource())];
    const [old] = await put(sa, [{ ref: "P", amount: 100n }]);
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, exact()));
    await runRecon(probe, { ...r, mode: "manual", from: D });
    const [fresh] = await put(sa, [{ ref: "P", amount: 120n }]);
    await db.update(records).set({ supersededBy: fresh! }).where(eq(records.id, old!));
    const run = await runRecon(probe, { ...r, mode: "manual", from: D });
    expect(run.counters).toMatchObject({ intake: { a: 1, b: 0 }, replaced: { a: 1, b: 0 }, open: { a: 1, b: 0 } });
    expect((await itemsOf(r.configId)).map((i) => [i.status, i.reason, i.version])).toEqual([["closed", "Source row replaced", 1], ["open", null, 0]]);
  });

  it("REC-FUT-15: a match whose record was replaced is reversed (source_changed), its items reopen, the new record pairs again", async () => {
    const [sa, sb] = [await source(A, plainSource()), await source(A, plainSource())];
    const [old] = await put(sa, [{ ref: "P", amount: 100n }]);
    await put(sb, [{ ref: "P", amount: 100n }]);
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, exact()));
    const first = await runRecon(probe, { ...r, mode: "manual", from: D });
    expect(first.counters.passes).toMatchObject({ 1: { matched: 1 } });
    // the mutable source sends the row again, changed: the old record is replaced by the new one
    const [fresh] = await put(sa, [{ ref: "P", amount: 100n }]);
    await db.update(records).set({ supersededBy: fresh! }).where(eq(records.id, old!));
    const run = await runRecon(probe, { ...r, mode: "manual", from: D });
    const groups = await db.select({ run: matchGroups.runId, by: matchGroups.reversedBy, why: matchGroups.reverseReason, at: matchGroups.reversedAt })
      .from(matchGroups).where(eq(matchGroups.configId, r.configId)).orderBy(asc(matchGroups.createdAt));
    // the first group reversed by the second run, the new record paired again in a new group
    expect(groups.map((g) => [g.run === first.runId, g.by, g.why, g.at !== null])).toEqual([[true, run.runId, "source_changed", true], [false, null, null, false]]);
    expect(run.counters).toMatchObject({ replaced: { a: 1, b: 0 }, passes: { 1: { matched: 1 } }, open: { a: 0, b: 0 } });
    // the replaced item closed, side B's item reopened and matched again, the new record's item matched
    expect((await itemsOf(r.configId)).map((i) => [i.side, i.status, i.reason]).sort()).toEqual([["a", "closed", "Source row replaced"], ["a", "matched", null], ["b", "matched", null]]);
  });

  it("empty text never matches through eq_normalized or contains", async () => {
    const [sa, sb] = [await source(A, plainSource()), await source(A, plainSource())];
    await put(sa, [{ ref: " - ", acct: "x" }, { ref: "ABC", acct: "" }]);
    await put(sb, [{ ref: "--", acct: "" }, { ref: "ZABCZ", acct: "y" }]);
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [
      { no: 1, name: "Norm", cardinality: "1:1", blocking: [], accept: "auto", on_ambiguous: "break", predicates: [{ op: "eq_normalized", field: "ext_ref" }] },
      { no: 2, name: "Contains", cardinality: "1:1", blocking: [], accept: "auto", on_ambiguous: "break", predicates: [{ op: "contains", field: "account_ref" }] },
    ]));
    expect((await runRecon(probe, { ...r, mode: "manual", from: D })).counters.passes).toMatchObject({ 1: { matched: 0, suggested: 0, broken: 0 }, 2: { matched: 0, suggested: 0, broken: 0 } });
  });

  it("a pass that fails rolls back alone (intake stays: it commits first) and marks the run failed with a sentence", async () => {
    const [sa, sb] = [await source(A, plainSource()), await source(A, plainSource())];
    await put(sa, [{ ref: "W", attrs: { when: "not a date" } }]);
    await put(sb, [{ ref: "W", attrs: { when: "2026-11-02" } }]);
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [
      { no: 1, name: "When", cardinality: "1:1", blocking: ["ext_ref"], accept: "auto", on_ambiguous: "break", predicates: [{ op: "date_window", field: "attrs.when", days: 1 }] },
    ]));
    const e = await runRecon(probe, { ...r, mode: "manual", from: D }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    const [run] = await db.select().from(reconRuns).where(eq(reconRuns.configId, r.configId));
    expect([run!.status, run!.error, run!.finishedAt !== null]).toEqual(["failed", "The run stopped on an internal error. Run it again; if it fails again, tell your admin.", true]);
    // the intake committed before the passes (statistics in between); the failed pass wrote nothing: no group, both open
    expect((await itemsOf(r.configId)).map((i) => [i.side, i.status])).toEqual([["a", "open"], ["b", "open"]]);
    expect(await db.select().from(matchGroups).where(eq(matchGroups.configId, r.configId))).toEqual([]);
    expect(run!.doneThrough).toBeNull();
  });

  it("refuses a range past 31 days or backwards, and marks a run that fails", async () => {
    const [sa, sb] = [await source(A, plainSource()), await source(A, plainSource())];
    const r = await recon(A, spec(sa.sourceId, sb.sourceId, [gateSpec("", "").passes[0]]));
    const long = await runRecon(probe, { ...r, mode: "manual", from: "2026-11-01", to: "2026-12-02" }).catch((x: unknown) => x);
    expect((long as Error).message).toBe("A run covers at most 31 business dates.");
    const back = await runRecon(probe, { ...r, mode: "manual", from: D1, to: D }).catch((x: unknown) => x);
    expect((back as Error).message).toBe("Pick a business date range that starts on or before its end.");
    expect(await db.select().from(reconRuns)).toEqual([]);
  });
});

beforeAll(async () => {
  probe = await appRoleDb();
  ({ sql: src, secret } = await sourceDb());
});
afterAll(async () => {
  await probe.$client.close();
  await src.close();
});
