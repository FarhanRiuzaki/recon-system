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
import { encryptSecret } from "../../../../kernel/crypto";
import { db } from "../../../../kernel/db";
import { QUEUES } from "../../../../kernel/jobs";
import { ensureMonthPartitions } from "../../../../kernel/partitions";
import { ingestHandlers, records } from "../../../ingest";
import { reconConfigs, reconConfigVersions } from "../../../recon";
import { calendars, sourceConnections, sources, sourceShares, sourceVersions } from "../../../sources";
import { spaces } from "../../../spaces";
import { matchGroups, matchMembers, reconItems, reconRuns } from "../../schema";
import { runRecon } from "../../service";

type Probe = Awaited<ReturnType<typeof appRoleDb>>;
let probe: Probe, src: SQL, secret: Awaited<ReturnType<typeof sourceDb>>["secret"];
const A = Bun.randomUUIDv7(), B = Bun.randomUUIDv7(), U = Bun.randomUUIDv7();

const ref = (k: number) => `TSTREF${String(k).padStart(6, "0")}`;
const range = (a: number, b: number, skip: number[] = []) => Array.from({ length: b - a + 1 }, (_, i) => a + i).filter((k) => !skip.includes(k)).map(ref);

/** A source of `spaceId` with version 1 published (a connection to `<test>_src` for a database source). */
async function source(spaceId: string, spec: SourceSpec) {
  const sourceId = Bun.randomUUIDv7(), versionId = Bun.randomUUIDv7();
  await db.insert(sources).values({ id: sourceId, spaceId, code: `s-${sourceId.slice(-12)}`, name: "S", kind: spec.input.kind });
  await db.insert(sourceVersions).values({ id: versionId, spaceId, sourceId, version: 1, status: "published", spec, specHash: "h", makerId: U, publishedAt: new Date() });
  if (spec.input.kind !== "file_inbox") {
    await db.insert(sourceConnections).values({ spaceId, sourceId, engine: "postgres", secretEnc: encryptSecret(JSON.stringify(secret)), options: { tls: false, connectTimeoutSeconds: 5 } });
  }
  return { spaceId, sourceId, versionId };
}
type Src = Awaited<ReturnType<typeof source>>;

/** A recon of `spaceId` with version 1 of `spec` published (status `status`). */
async function recon(spaceId: string, spec: unknown, status = "published") {
  const configId = Bun.randomUUIDv7(), versionId = Bun.randomUUIDv7();
  await db.insert(reconConfigs).values({ id: configId, spaceId, code: `r-${configId.slice(-12)}`, name: "R" });
  await db.insert(reconConfigVersions).values({ id: versionId, configId, spaceId, version: 1, status, spec, specHash: "h", makerId: U });
  return { spaceId, configId, versionId };
}

// ------------------------------------------------------------------------------------------------ the gate
/** recon_source_test's source1 / source2 (docs/recon/source-test-db.md) pulled by watermark, with the gate mapping. */
const gateSource = (n: 1 | 2): SourceSpec => {
  const [ref, date, amount, ccy, acct] = n === 1 ? ["txn_ref", "business_date", "amount_minor", "ccy", "account_no"] : ["reference", "value_date", "amount", "currency", "acct"];
  return {
    fields: [
      { name: ref, type: "string", nullable: false, trim: true }, { name: date, type: "date", nullable: false, trim: true },
      { name: amount, type: "integer", nullable: false, trim: true }, { name: ccy, type: "string", nullable: false, trim: true },
      { name: acct, type: "string", nullable: false, trim: true },
    ],
    mapping: {
      ext_ref: { field: ref }, business_date: { field: date }, amount_minor: { field: amount, unit: "minor" }, currency: { field: ccy }, account_ref: { field: acct }, attrs: {},
    },
    derive: {}, key_fields: [], mutable: false, calendar: "id-default",
    input: { kind: "db_watermark", table: `core.source${n}`, watermark: { column: "updated_at", id_column: "id" }, lookback_seconds: 0, chunk: 500 },
  } as SourceSpec;
};
const ccyEq = { op: "eq", field: "currency" };
/** The gate config (plan "Config gerbang"). */
const gateSpec = (a: string, b: string) => ({
  sides: [{ key: "a", label: "Source 1", source_id: a, filter: [] }, { key: "b", label: "Source 2", source_id: b, filter: [] }],
  passes: [
    { no: 1, name: "Exact", cardinality: "1:1", blocking: [], accept: "auto", on_ambiguous: "break",
      predicates: [{ op: "eq", field: "ext_ref" }, { op: "eq", field: "amount_minor" }, { op: "eq", field: "business_date" }, ccyEq] },
    { no: 2, name: "Amount tolerance", cardinality: "1:1", blocking: ["ext_ref", "business_date"], accept: "suggest", on_ambiguous: "suggest",
      predicates: [{ op: "amount_abs_tol", field: "amount_minor", tolerance: { IDR: "1000.00" } }, ccyEq] },
    { no: 3, name: "Date window", cardinality: "1:1", blocking: ["ext_ref"], accept: "suggest", on_ambiguous: "suggest",
      predicates: [{ op: "eq", field: "amount_minor" }, { op: "date_window", field: "business_date", days: 1 }, ccyEq] },
  ],
  grace_minutes: 30, carry_over_days: 1, close_at: "23:00", schedule: { kind: "daily", at: "23:30", business_date_offset: 0 },
});

/** Every live item of `configId` with its record's reference. */
const itemsOf = (configId: string) => db.select({ id: reconItems.id, side: reconItems.side, status: reconItems.status, reason: reconItems.breakReason, date: reconItems.businessDate, version: reconItems.version, ref: records.extRef })
  .from(reconItems).innerJoin(records, and(eq(records.id, reconItems.recordId), eq(records.businessDate, reconItems.businessDate)))
  .where(and(eq(reconItems.configId, configId), sql`${reconItems.simRunId} is null`)).orderBy(asc(records.extRef), asc(reconItems.side), asc(reconItems.id));
/** Every group of `configId` (of run `runId` when given) with its members' references, sides and amounts. */
async function groupsOf(configId: string, runId?: string) {
  const rows = await db.select({ id: matchGroups.id, pass: matchGroups.passNo, kind: matchGroups.kind, date: matchGroups.businessDate, evidence: matchGroups.evidence, side: matchMembers.side, ref: records.extRef, amount: matchMembers.signedAmount })
    .from(matchGroups).innerJoin(matchMembers, eq(matchMembers.groupId, matchGroups.id)).innerJoin(reconItems, eq(reconItems.id, matchMembers.itemId))
    .innerJoin(records, and(eq(records.id, reconItems.recordId), eq(records.businessDate, reconItems.businessDate)))
    .where(and(eq(matchGroups.configId, configId), runId ? eq(matchGroups.runId, runId) : undefined)).orderBy(asc(matchGroups.id), asc(matchMembers.side));
  const by = new Map<string, { pass: number; kind: string; date: string; evidence: unknown; refs: string[]; sides: string[]; amounts: (bigint | null)[] }>();
  for (const r of rows) {
    const g = by.get(r.id) ?? { pass: r.pass, kind: r.kind, date: r.date, evidence: r.evidence, refs: [], sides: [], amounts: [] };
    g.refs.push(r.ref!); g.sides.push(r.side); g.amounts.push(r.amount);
    by.set(r.id, g);
  }
  return [...by.values()];
}
const refsOf = (gs: { refs: string[] }[]) => [...new Set(gs.flatMap((g) => g.refs))].sort();

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
      intake: { a: 1000, b: 1000 },
      passes: { 1: { matched: 937, suggested: 0, broken: 30 }, 2: { matched: 0, suggested: 14, broken: 0 }, 3: { matched: 0, suggested: 10, broken: 0 } },
      open: { a: 24, b: 24 },
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

  it("Focus 3: the same run again changes nothing (no group, no item moved)", async () => {
    const before = [await itemsOf(gate.configId), await groupsOf(gate.configId)];
    const again = await runRecon(probe, { ...gate, mode: "rerun", from: "2026-11-02", to: "2026-11-05" });
    expect(again.counters).toEqual({
      intake: { a: 0, b: 0 },
      passes: { 1: { matched: 0, suggested: 0, broken: 0 }, 2: { matched: 0, suggested: 0, broken: 0 }, 3: { matched: 0, suggested: 0, broken: 0 } },
      open: { a: 24, b: 24 },
    });
    expect([await itemsOf(gate.configId), await groupsOf(gate.configId)]).toEqual(before);
    expect((await groupsOf(gate.configId, firstRun)).length).toBe(961);
  }, 60_000);

  it("a simulation of a draft gives the same answer in its own rows and touches no live item", async () => {
    const live = [await itemsOf(gate.configId), await groupsOf(gate.configId)];
    const draft = Bun.randomUUIDv7();
    await db.insert(reconConfigVersions).values({ id: draft, configId: gate.configId, spaceId: A, version: 2, status: "draft", spec: gateSpec(...gateSides), specHash: "h2", makerId: U });
    const sim = await runRecon(probe, { ...gate, versionId: draft, mode: "simulation", from: "2026-11-02", to: "2026-11-05" });
    expect(sim.counters.passes).toEqual({ 1: { matched: 937, suggested: 0, broken: 30 }, 2: { matched: 0, suggested: 14, broken: 0 }, 3: { matched: 0, suggested: 10, broken: 0 } });
    expect((await groupsOf(gate.configId, sim.runId)).length).toBe(961);
    expect((await db.select({ n: sql<number>`count(*)::int` }).from(reconItems).where(eq(reconItems.simRunId, sim.runId)))[0]!.n).toBe(2000);
    expect([await itemsOf(gate.configId), (await groupsOf(gate.configId)).filter((g) => (g.evidence as { runId: string }).runId !== sim.runId)]).toEqual(live);
    // a draft never runs live
    const e = await runRecon(probe, { ...gate, versionId: draft, mode: "manual", from: "2026-11-02" }).catch((x: unknown) => x);
    expect((e as Error).message).toBe("Only the published version of a recon runs.");
  }, 60_000);
});

// ------------------------------------------------------------------------------------------------ records written directly
/** A file source (never pulled: its records are written by the test) with core fields and attrs.settlement_ref. */
const plainSource = (): SourceSpec => ({
  fields: [
    { name: "ref", type: "string", nullable: false, trim: true }, { name: "amount", type: "integer", nullable: true, trim: true },
    { name: "date", type: "date", nullable: false, trim: true }, { name: "ccy", type: "string", nullable: true, trim: true },
    { name: "acct", type: "string", nullable: true, trim: true }, { name: "sref", type: "string", nullable: true, trim: true },
  ],
  mapping: {
    ext_ref: { field: "ref" }, amount_minor: { field: "amount", unit: "minor" }, business_date: { field: "date" }, currency: { field: "ccy" },
    account_ref: { field: "acct" }, attrs: { settlement_ref: { field: "sref" } },
  },
  derive: {}, key_fields: [], mutable: false, calendar: "id-default",
  input: { kind: "file_inbox", path: "/inbox/x", pattern: "*.csv", completion: { kind: "stable_seconds", seconds: 60 }, format: { kind: "delimited", delimiter: ",", quote: '"', header: true, encoding: "utf-8" } },
} as SourceSpec);
type Rec = { ref?: string; amount?: bigint; ccy?: string; date?: string; acct?: string; sref?: string };
/** Writes records of `s` (as ingest would have: current, no snapshot); answers their ids in order. */
async function put(s: Src, rows: Rec[]): Promise<string[]> {
  const vals = rows.map((r) => ({
    id: Bun.randomUUIDv7(), spaceId: s.spaceId, sourceId: s.sourceId, sourceVersionId: s.versionId, businessDate: r.date ?? D, bdayIndex: 0,
    extRef: r.ref ?? null, accountRef: r.acct ?? null, amountMinor: r.amount ?? null, currency: r.ccy ?? "IDR",
    attrs: r.sref ? { settlement_ref: r.sref } : {}, rowHash: Bun.randomUUIDv7(), originId: Bun.randomUUIDv7(),
  }));
  await db.insert(records).values(vals);
  return vals.map((v) => v.id);
}
const D = "2026-11-02", D1 = "2026-11-03";
const spec = (a: string, b: string, passes: unknown[], carry = 1) => ({ ...gateSpec(a, b), passes, carry_over_days: carry });

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
    expect(run.counters.passes).toEqual({ 1: { matched: 1, suggested: 1, broken: 0 } });
    const groups = await groupsOf(r.configId);
    const auto = groups.find((g) => g.kind === "auto")!;
    expect([auto.refs, auto.amounts]).toEqual([["K1", "K1"], [1_000_500n, 1_000_400n]]);
    const tie = groups.find((g) => g.kind === "suggested")!;
    expect([tie.refs, tie.amounts[0]]).toEqual([["K2", "K2"], 500_000n]);
    expect(tie.evidence).toMatchObject({ chosen: "tie broken by earliest business date, then id" });
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
      expect(run.counters.passes).toEqual({ 1: { matched: 1, suggested: 0, broken: 0 } });
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
    expect(run.counters.passes).toEqual({ 1: { matched: 1, suggested: 0, broken: 0 } });
    const [g, ...more] = await groupsOf(r.configId);
    expect(more).toEqual([]);
    expect([g!.kind, g!.date, g!.refs.sort(), g!.sides.sort().join("")]).toEqual(["auto", D1, ["S1", "T1", "T2", "T3"], "aaab"]);
    expect(g!.evidence).toMatchObject({ chosen: "group sum, one counterpart", predicates: [{ op: "eq_sum", sum: 1000, one: 1000, delta: 0, members: 3 }, { op: "eq" }] });
    // ST2's sum is 50 against 60: it waits
    expect((await itemsOf(r.configId)).filter((i) => i.status === "open").map((i) => i.ref)).toEqual(["S2", "T4"]);
    // carry over 0: a settlement on D+1 never meets transactions of D
    const r0 = await recon(A, spec(txn.sourceId, stl.sourceId, passes, 0));
    expect((await runRecon(probe, { ...r0, mode: "manual", from: D, to: D1 })).counters.passes).toEqual({ 1: { matched: 0, suggested: 0, broken: 0 } });
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
    expect(run.counters).toEqual({ intake: { a: 10, b: 11 }, passes: { 1: { matched: 8, suggested: 0, broken: 3 } }, open: { a: 1, b: 1 } });
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
