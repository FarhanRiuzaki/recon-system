// A run's latency on PERF_ENGINE_ROWS records per side of one business date (default 5000, then 20000), as the app role
// (RLS on, as the worker's workerDb); docs/recon/spikes.md "Plan 3 engine". The records are written by SQL; every
// reference exists on both sides, 3% of side B's amounts are 500 minor off (pass 2 suggests them).
// Off unless asked: it truncates the test database.
//   PERF_ENGINE=1 bun test src/modules/engine/tests/integration/run-perf.test.ts
//   PERF_ANALYZE_RECORDS=1 …   the records analyzed before the run (as autovacuum would have, some time after ingest)
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { SourceSpec } from "@starterkit/shared/contracts/sources";
import { eq, sql } from "drizzle-orm";
import { appRoleDb } from "../../../../../test/helpers/app-role";
import { truncateAll } from "../../../../../test/helpers/db";
import { db } from "../../../../kernel/db";
import { ensureMonthPartitions } from "../../../../kernel/partitions";
import { records } from "../../../ingest";
import { reconConfigs, reconConfigVersions } from "../../../recon";
import { sources, sourceVersions } from "../../../sources";
import { spaces, withSpace } from "../../../spaces";
import type { Ctx } from "../../../auth";
import { classifyUnmatched, runDetail, runItemPage, runRecon } from "../../service";

const A = Bun.randomUUIDv7();
const D = "2026-11-02";
const SIZES = process.env.PERF_ENGINE_ROWS ? [Number(process.env.PERF_ENGINE_ROWS)] : [5000, 20000];
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
  await db.execute(sql`insert into records (id, space_id, source_id, source_version_id, business_date, bday_index, ext_ref, amount_minor, currency, attrs, row_hash, origin_id)
    select uuidv7(), ${A}::uuid, ${id}::uuid, ${v}::uuid, ${D}::date, 1, 'R' || g, 100000 + g + case when ${off} and g % 33 = 0 then 500 else 0 end, 'IDR', '{}'::jsonb, md5(g::text), ${v}::uuid
    from generate_series(1, ${n}) g`);
  return id;
}

describe.if(!!process.env.PERF_ENGINE)("run latency", () => {
  beforeAll(async () => {
    await truncateAll();
    await db.insert(spaces).values({ id: A, code: "a", name: "A" });
    await db.transaction((tx) => ensureMonthPartitions(tx, records, new Date(`${D}T00:00:00Z`), 1));
    probe = await appRoleDb();
  });
  afterAll(() => probe?.$client.close());

  for (const n of SIZES) {
    it(`${n} records per side`, async () => {
      const [a, b] = [await side(n, false), await side(n, true)];
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
