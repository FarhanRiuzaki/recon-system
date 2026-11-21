// A run's latency on PERF_ENGINE_ROWS records per side of one business date (default 5000, then 20000), as the app role
// (RLS on, as the worker's workerDb); docs/recon/spikes.md "Plan 3 engine". The records are written by SQL; every
// reference exists on both sides, 3% of side B's amounts are 500 minor off (pass 2 suggests them).
// Off unless asked: it truncates the test database.
//   PERF_ENGINE=1 bun test src/modules/engine/tests/integration/run-perf.test.ts
//   PERF_ANALYZE_RECORDS=1 …   the records analyzed before the run (as autovacuum would have, some time after ingest)
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { SourceSpec } from "@starterkit/shared/contracts/sources";
import { SQL } from "bun";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { appRoleDb } from "../../../../../test/helpers/app-role";
import { truncateAll } from "../../../../../test/helpers/db";
import { db } from "../../../../kernel/db";
import { ensureMonthPartitions } from "../../../../kernel/partitions";
import { records } from "../../../ingest";
import { reconConfigs, reconConfigVersions } from "../../../recon";
import { sources, sourceVersions } from "../../../sources";
import { spaces, withSpace } from "../../../spaces";
import type { Ctx } from "../../../auth";
import { reconRuns } from "../../schema";
import { classifyUnmatched, refreshRunDays, runDetail, runItemPage, runRecon } from "../../service";

const A = Bun.randomUUIDv7();
const D = "2026-11-02";
// PERF_ENGINE_CONFIGS=3: that many configs of PERF_ENGINE_ROWS each on the same date (a table shared by several configs)
const SIZES = process.env.PERF_ENGINE_ROWS ? Array.from({ length: Number(process.env.PERF_ENGINE_CONFIGS ?? 1) }, () => Number(process.env.PERF_ENGINE_ROWS)) : [5000, 20000];
let probe: Awaited<ReturnType<typeof appRoleDb>>;

const spec = {
  fields: [{ name: "ref", type: "string", nullable: false, trim: true }, { name: "amount", type: "integer", nullable: false, trim: true }, { name: "date", type: "date", nullable: false, trim: true }, { name: "ccy", type: "string", nullable: false, trim: true }],
  mapping: { ext_ref: { field: "ref" }, amount_minor: { field: "amount", unit: "minor" }, business_date: { field: "date" }, currency: { field: "ccy" }, attrs: {} },
  derive: {}, key_fields: [], mutable: false, calendar: "id-default",
  input: { kind: "file_inbox", path: "/inbox/x", pattern: "*.csv", completion: { kind: "stable_seconds", seconds: 60 }, format: { kind: "delimited", delimiter: ",", quote: '"', header: true, encoding: "utf-8" } },
} as SourceSpec;

async function side(n: number, off: boolean) {
  const id = Bun.randomUUIDv7(), v = Bun.randomUUIDv7();
  await db.insert(sources).values({ id, spaceId: A, code: `p-${id.slice(-12)}`, name: "P", kind: "file_inbox" });
  await db.insert(sourceVersions).values({ id: v, spaceId: A, sourceId: id, version: 1, status: "published", spec, specHash: "h", makerId: A, publishedAt: new Date() });
  // per 100,000: one statement of the API pool stays under its 5 s timeout
  for (let g = 1; g <= n; g += 100_000) await more(id, v, g, Math.min(n, g + 99_999), off);
  return { id, v };
}

/** Records `from`..`to` of source `id` (references R<g>; with `off`, every 33rd amount 500 minor off). */
const more = (id: string, v: string, from: number, to: number, off: boolean) =>
  db.execute(sql`insert into records (id, space_id, source_id, source_version_id, business_date, bday_index, ext_ref, amount_minor, currency, attrs, row_hash, origin_id)
    select uuidv7(), ${A}::uuid, ${id}::uuid, ${v}::uuid, ${D}::date, 1, 'R' || g, 100000 + g + case when ${off} and g % 33 = 0 then 500 else 0 end, 'IDR', '{}'::jsonb, md5(g::text), ${v}::uuid
    from generate_series(${from}::int, ${to}::int) g`);

/** A published config of sides `a`, `b`: pass 1 exact (reference, amount, currency), pass 2 amount within 10.00 IDR, suggest. */
async function config(a: string, b: string) {
  const configId = Bun.randomUUIDv7(), versionId = Bun.randomUUIDv7();
  const ccyEq = { op: "eq", field: "currency" };
  await db.insert(reconConfigs).values({ id: configId, spaceId: A, code: `r-${configId.slice(-12)}`, name: "R" });
  await db.insert(reconConfigVersions).values({
    id: versionId, configId, spaceId: A, version: 1, status: "published", specHash: "h", makerId: A, spec: {
      sides: [{ key: "a", label: "A", source_id: a, filter: [] }, { key: "b", label: "B", source_id: b, filter: [] }],
      passes: [
        { no: 1, name: "Exact", cardinality: "1:1", blocking: [], accept: "auto", on_ambiguous: "break", predicates: [{ op: "eq", field: "ext_ref" }, { op: "eq", field: "amount_minor" }, ccyEq] },
        { no: 2, name: "Tolerance", cardinality: "1:1", blocking: ["ext_ref"], accept: "suggest", on_ambiguous: "suggest", predicates: [{ op: "amount_abs_tol", field: "amount_minor", tolerance: { IDR: "10.00" } }, ccyEq] },
      ],
      grace_minutes: 30, carry_over_days: 0, close_at: "23:00", schedule: { kind: "daily", at: "23:30", business_date_offset: 0 },
    },
  });
  return { configId, versionId };
}

describe.if(!!process.env.PERF_ENGINE)("run latency", () => {
  beforeAll(async () => {
    await truncateAll();
    await db.insert(spaces).values({ id: A, code: "a", name: "A" });
    await db.transaction((tx) => ensureMonthPartitions(tx, records, new Date(`${D}T00:00:00Z`), 1));
    probe = await appRoleDb();
    // past 20,000 a side a step runs longer than the test pool's 30 s: the worker's own timeout (JOB_STATEMENT_TIMEOUT_MS)
    if (SIZES.some((n) => n > 20_000)) {
      await probe.$client.close();
      probe = drizzle({ client: new SQL(process.env.DATABASE_URL!, { max: 4, connection: { role: "recon_app_probe", statement_timeout: 600_000, idle_in_transaction_session_timeout: 600_000 } }) });
    }
  });
  afterAll(() => probe?.$client.close());

  for (const [k, n] of SIZES.entries()) {
    it(`${n} records per side (config ${k + 1})`, async () => {
      const [a, b] = [(await side(n, false)).id, (await side(n, true)).id];
      const { configId, versionId } = await config(a, b);
      if (process.env.PERF_ANALYZE_RECORDS) await db.execute(sql`analyze records`);
      const t0 = performance.now();
      const run = await runRecon(probe, { spaceId: A, configId, versionId, mode: "manual", from: D });
      console.log(`run ${n}/side: ${Math.round(performance.now() - t0)} ms`, JSON.stringify(run.counters.passes));
      // the reads of the results screen on the API's pool (5 s statement timeout): the run with its days, items of pass 1
      const ctx = { space: { id: A, roles: [] }, user: { id: A } } as unknown as Ctx;
      const q = { page: 1, pageSize: 100 } as const;
      for (const [name, read] of [
        ["GET run", () => runDetail(ctx, configId, run.runId)],
        ["items pass=1", () => runItemPage(ctx, configId, run.runId, { ...q, pass: 1 })],
        ["items pass=2 page 2", () => runItemPage(ctx, configId, run.runId, { ...q, pass: 2, page: 2 })],
        [`items date=${D}`, () => runItemPage(ctx, configId, run.runId, { ...q, date: D })],
      ] as const) {
        const t1 = performance.now();
        await read();
        console.log(`  ${name}: ${Math.round(performance.now() - t1)} ms`);
      }
      // a run's days again (daysOf, as after a close), in the worker; and the groups' GROUP BY's plan
      const t2 = performance.now();
      await refreshRunDays(probe, A, run.runId);
      console.log(`  daysOf (${n} groups-ish on one date): ${Math.round(performance.now() - t2)} ms`);
      const plan = (await db.execute(sql`explain (analyze, buffers) select business_date, pass_no, count(*) from match_groups
        where space_id = ${A} and config_id = ${configId} and sim_run_id is null and reversed_by is null and kind = 'auto'
          and business_date between ${D}::date and ${D}::date group by 1, 2`)) as unknown as { "QUERY PLAN": string }[];
      console.log(plan.map((x) => `    ${x["QUERY PLAN"]}`).join("\n"));
      const offs = Math.floor(n / 33);
      expect(run.counters.passes).toMatchObject({ 1: { matched: n - offs, suggested: 0, broken: 0 }, 2: { matched: 0, suggested: offs, broken: 0 } });
      // the near-miss classifier at its worst: no pass, every item open with a counterpart (day close, projection)
      const bare = Bun.randomUUIDv7(), bareV = Bun.randomUUIDv7();
      const [v] = await db.select({ spec: reconConfigVersions.spec }).from(reconConfigVersions).where(eq(reconConfigVersions.id, versionId));
      await db.insert(reconConfigs).values({ id: bare, spaceId: A, code: `r-${bare.slice(-12)}`, name: "R" });
      await db.insert(reconConfigVersions).values({ id: bareV, configId: bare, spaceId: A, version: 1, status: "published", specHash: "h", makerId: A, spec: { ...(v!.spec as object), passes: [] } });
      await runRecon(probe, { spaceId: A, configId: bare, versionId: bareV, mode: "manual", from: D });
      const t1 = performance.now();
      const misses = await withSpace({ spaceIds: [A], userId: null }, (tx) => classifyUnmatched(tx, { spaceId: A, configId: bare, versionId: bareV, simRunId: null, from: D, to: D }), probe);
      console.log(`classifier ${n}/side open: ${Math.round(performance.now() - t1)} ms`);
      expect(misses.length).toBe(2 * n);
    }, 600_000);
  }
});

// REC-P1 gate (1), a BI-FAST tick late in the day: PERF_TICK_BASE records a side already run on date D (default
// 1,000,000), then PERF_TICK_COUNT ticks (default 3) of 5,000 new records a side each, every tick a run of D as the
// schedule starts it. The base run is a daily run (REC-P1 gate 2 at 3M), all on the worker's statement timeout
// (JOB_STATEMENT_TIMEOUT_MS default, 120 s); pg-boss's dispatch is not in the number. docs/recon/spikes.md "REC-P1".
//   PERF_TICK=1 [PERF_TICK_BASE=…] bun test src/modules/engine/tests/integration/run-perf.test.ts
describe.if(!!process.env.PERF_TICK)("tick on a full day", () => {
  const BASE = Number(process.env.PERF_TICK_BASE ?? 1_000_000), TICK = 5000, TICKS = Number(process.env.PERF_TICK_COUNT ?? 3);
  let worker: Awaited<ReturnType<typeof appRoleDb>>;
  beforeAll(async () => {
    await truncateAll();
    await db.insert(spaces).values({ id: A, code: "a", name: "A" });
    await db.transaction((tx) => ensureMonthPartitions(tx, records, new Date(`${D}T00:00:00Z`), 1));
    const pool = (ms: number) => drizzle({ client: new SQL(process.env.DATABASE_URL!, { max: 4, connection: { role: "recon_app_probe", statement_timeout: ms, idle_in_transaction_session_timeout: 600_000 } }) });
    // the worker's pool as configured by default; a date's passes take their queue's job expiry (passTimeoutMs)
    worker = pool(120_000);
  });
  afterAll(() => worker?.$client.close());

  it(`${TICKS} ticks of ${TICK} a side over ${BASE} a side`, async () => {
    const [a, b] = [await side(BASE, false), await side(BASE, true)];
    const { configId, versionId } = await config(a.id, b.id);
    const t0 = performance.now();
    await runRecon(worker, { spaceId: A, configId, versionId, mode: "daily", from: D });
    console.log(`base run ${BASE}/side: ${Math.round(performance.now() - t0)} ms`);
    const took: number[] = [];
    for (let k = 0; k < TICKS; k++) {
      const lo = BASE + k * TICK + 1, hi = lo + TICK - 1;
      await more(a.id, a.v, lo, hi, false);
      await more(b.id, b.v, lo, hi, true);
      const t1 = performance.now();
      const run = await runRecon(worker, { spaceId: A, configId, versionId, mode: "tick", from: D });
      took.push(Math.round(performance.now() - t1));
      console.log(`tick ${k + 1}: ${took.at(-1)} ms`, JSON.stringify(run.counters.intake), JSON.stringify(run.counters.passes["1"]?.matched));
      expect(run.counters.intake).toEqual({ a: TICK, b: TICK });
    }
    expect(Math.max(...took)).toBeLessThan(30_000);
  }, 3_600_000);
});

// REC-P1 gate (3), the results screen's reads over history: PERF_READ_CONFIGS configs (default 3), each with
// PERF_READ_ROWS records a side (default 20,000) on each of PERF_READ_DAYS business dates (default 31), one live run
// per config over all its dates. Then the reads on the API's pool (5 s statement timeout), each the median of 5:
//   PERF_READ=1 [PERF_READ_ROWS=… PERF_READ_DAYS=… PERF_READ_CONFIGS=…] bun test src/modules/engine/tests/integration/run-perf.test.ts
// PERF_READ_REUSE=1 reads the history the last PERF_READ run left in the test database (no truncate, no runs): a read
// over the timeout is recorded as such, not thrown, so every read is measured.
describe.if(!!process.env.PERF_READ)("results screen reads over history", () => {
  const ROWS = Number(process.env.PERF_READ_ROWS ?? 20_000), DAYS = Number(process.env.PERF_READ_DAYS ?? 31), CONFIGS = Number(process.env.PERF_READ_CONFIGS ?? 3);
  const first = "2026-10-01";
  const dateOf = (i: number) => new Date(Date.parse(`${first}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);
  const last = dateOf(DAYS - 1), mid = dateOf(Math.floor(DAYS / 2));
  /** Records of source `id` for every date, ROWS a date (references R<date index>-<g>; `off`: every 33rd amount 500 minor off). */
  const fill = async (id: string, v: string, off: boolean) => {
    for (let d = 0; d < DAYS; d++) {
      for (let g = 1; g <= ROWS; g += 100_000) {
        await db.execute(sql`insert into records (id, space_id, source_id, source_version_id, business_date, bday_index, ext_ref, amount_minor, currency, attrs, row_hash, origin_id)
          select uuidv7(), ${A}::uuid, ${id}::uuid, ${v}::uuid, ${dateOf(d)}::date, ${d + 1}, 'R' || ${d} || '-' || g, 100000 + g + case when ${off} and g % 33 = 0 then 500 else 0 end, 'IDR', '{}'::jsonb, md5(${d} || '-' || g), ${v}::uuid
          from generate_series(${g}::int, ${Math.min(ROWS, g + 99_999)}::int) g`);
      }
    }
  };
  const median = async (read: () => Promise<unknown>) => {
    const ms: number[] = [];
    for (let i = 0; i < 5; i++) { const t = performance.now(); await read(); ms.push(performance.now() - t); }
    return Math.round(ms.sort((x, y) => x - y)[2]!);
  };

  const REUSE = !!process.env.PERF_READ_REUSE;
  beforeAll(async () => {
    if (REUSE) return;
    await truncateAll();
    await db.insert(spaces).values({ id: A, code: "a", name: "A" });
    await db.transaction((tx) => ensureMonthPartitions(tx, records, new Date(`${first}T00:00:00Z`), 3));
    await probe?.$client.close();
    probe = drizzle({ client: new SQL(process.env.DATABASE_URL!, { max: 4, connection: { role: "recon_app_probe", statement_timeout: 3_600_000, idle_in_transaction_session_timeout: 3_600_000 } }) });
  });
  afterAll(() => probe?.$client.close());

  it(`${CONFIGS} configs × ${DAYS} days × ${ROWS} records a side`, async () => {
    const runs: { configId: string; runId: string; spaceId?: string }[] = REUSE
      ? (await db.select({ configId: reconRuns.configId, runId: reconRuns.id, spaceId: reconRuns.spaceId }).from(reconRuns).where(eq(reconRuns.status, "succeeded")).orderBy(reconRuns.startedAt))
      : [];
    for (let k = 0; k < (REUSE ? 0 : CONFIGS); k++) {
      const sides = [];
      for (const off of [false, true]) {
        const id = Bun.randomUUIDv7(), v = Bun.randomUUIDv7();
        await db.insert(sources).values({ id, spaceId: A, code: `p-${id.slice(-12)}`, name: "P", kind: "file_inbox" });
        await db.insert(sourceVersions).values({ id: v, spaceId: A, sourceId: id, version: 1, status: "published", spec, specHash: "h", makerId: A, publishedAt: new Date() });
        await fill(id, v, off);
        sides.push(id);
      }
      const { configId, versionId } = await config(sides[0]!, sides[1]!);
      await db.execute(sql`analyze records`);
      const t0 = performance.now();
      const run = await runRecon(probe, { spaceId: A, configId, versionId, mode: "manual", from: first, to: last });
      console.log(`config ${k + 1}: run ${DAYS} days × ${ROWS}/side in ${Math.round((performance.now() - t0) / 1000)} s`);
      runs.push({ configId, runId: run.runId });
    }
    await db.execute(sql`analyze recon_items`); await db.execute(sql`analyze match_groups`); await db.execute(sql`analyze match_members`);
    const [{ items }] = (await db.execute(sql`select count(*)::int as items from recon_items`)) as unknown as [{ items: number }];
    console.log(`history: ${items} items, ${CONFIGS} configs`);
    // the reads of the results screen, on the API's pool, of the last config's run (the others share the tables)
    const { configId, runId, spaceId = A } = runs.at(-1)!;
    const ctx = { space: { id: spaceId, roles: [] }, user: { id: spaceId } } as unknown as Ctx;
    const q = { page: 1, pageSize: 100 } as const;
    const reads = [
      ["GET run", () => runDetail(ctx, configId, runId), 50],
      ["items pass=1", () => runItemPage(ctx, configId, runId, { ...q, pass: 1 }), 2000],
      ["items pass=2 page 2", () => runItemPage(ctx, configId, runId, { ...q, pass: 2, page: 2 }), 2000],
      [`items date=${mid}`, () => runItemPage(ctx, configId, runId, { ...q, date: mid }), 2000],
      ["items status=suggested (pairs)", () => runItemPage(ctx, configId, runId, { ...q, status: "suggested" }), 2000],
      ["items own=1 page 50", () => runItemPage(ctx, configId, runId, { ...q, own: "1", page: 50 }), 2000],
    ] as const;
    const out: string[] = [];
    for (const [name, read, limit] of reads) {
      const ms = await median(read).catch((e: unknown) => (String((e as { cause?: unknown }).cause ?? e).includes("statement timeout") ? Infinity : Promise.reject(e)));
      out.push(`${name}: ${ms === Infinity ? "past the 5 s statement timeout" : `${ms} ms`} (target ≤ ${limit} ms)${ms > limit ? " OVER" : ""}`);
    }
    console.log(out.map((x) => `  ${x}`).join("\n"));
    expect(out.filter((x) => x.endsWith("OVER"))).toEqual([]);
  }, 3_600_000);
});
