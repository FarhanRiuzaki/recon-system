// rowsToday latency (sourceStates, RLS on) as the app role, on PERF_ROWS records (default 1M) of one business date per
// source; docs/recon/spikes.md "rowsToday". The rows are written by SQL, so their day counters come from recountDays.
// Off unless asked: it seeds millions of rows into the test database (minutes) and truncates it.
//   PERF_ROWS_TODAY=1 bun test src/modules/ingest/tests/integration/rows-today-perf.test.ts      two sources of 1M, 13 empty
//   PERF_ROWS_TODAY=1 PERF_ALL=1 bun test …                                                        all 15 sources of 1M
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { SourceSpec } from "@starterkit/shared/contracts/sources";
import { sql } from "drizzle-orm";
import { appRoleDb } from "../../../../../test/helpers/app-role";
import { truncateAll } from "../../../../../test/helpers/db";
import { db } from "../../../../kernel/db";
import { ensureMonthPartitions } from "../../../../kernel/partitions";
import { calendars, sources, sourceVersions } from "../../../sources";
import { spaces, withSpace } from "../../../spaces";
import { records, sourceSnapshots } from "../../schema";
import { type ReadSource, recountDays, sourceStates } from "../../service";
import { ksei } from "../unit/fixtures";

const A = Bun.randomUUIDv7();
const NOW = new Date("2026-11-03T03:00:00Z"); // business date of a file/snapshot source: 2026-11-02
const D = "2026-11-02";
const N = Number(process.env.PERF_ROWS ?? 1_000_000);
let probe: Awaited<ReturnType<typeof appRoleDb>>;
const list: ReadSource[] = [];

async function mk(kind: "file_inbox" | "db_snapshot", rows: number) {
  const id = Bun.randomUUIDv7(), v = Bun.randomUUIDv7();
  const spec: SourceSpec = kind === "file_inbox" ? ksei() : { ...ksei(), input: { kind: "db_snapshot", query: "select 1 where :business_date is not null", schedule: "0 6 * * *" } } as SourceSpec;
  await db.insert(sources).values({ id, spaceId: A, code: `p-${id.slice(-12)}`, name: "P", kind });
  await db.insert(sourceVersions).values({ id: v, spaceId: A, sourceId: id, version: 1, status: "published", spec, specHash: "h", makerId: A, publishedAt: new Date() });
  let snap: string | null = null;
  if (kind === "db_snapshot") {
    snap = Bun.randomUUIDv7();
    await db.insert(sourceSnapshots).values({ id: snap, spaceId: A, sourceId: id, businessDate: D, status: "active", rows });
  }
  if (rows) {
    await db.transaction(async (tx) => { await tx.execute(sql`set local statement_timeout = 0`); await tx.execute(sql`insert into records (id, space_id, source_id, source_version_id, business_date, bday_index, attrs, row_hash, origin_id, snapshot_id)
      select gen_random_uuid(), ${A}::uuid, ${id}::uuid, ${v}::uuid, ${D}::date, 1, '{}'::jsonb, md5(g::text), ${v}::uuid, ${snap}::uuid from generate_series(1, ${rows}) g`); });
  }
  list.push({ id, spaceId: A, kind, status: "active", spec });
}

const time = async (label: string, l: ReadSource[]) => {
  const ms: number[] = [];
  for (let i = 0; i < 7; i++) {
    const t = performance.now();
    const out = await withSpace({ spaceIds: [A], userId: null }, (tx) => sourceStates(tx, l, A, NOW), probe);
    ms.push(performance.now() - t);
    if (i === 0) console.log(label, "rowsToday", [...out.values()].map((s) => s.rowsToday));
  }
  ms.sort((a, b) => a - b);
  console.log(JSON.stringify({ label, sources: l.length, medianMs: Math.round(ms[3]!), minMs: Math.round(ms[0]!), maxMs: Math.round(ms[6]!) }));
};

describe.skipIf(!process.env.PERF_ROWS_TODAY)("rowsToday on 1M records a day", () => {
beforeAll(async () => {
  await truncateAll();
  await db.insert(spaces).values({ id: A, code: "perf", name: "Perf" });
  await db.insert(calendars).values({ id: Bun.randomUUIDv7(), code: "id-default", name: "Default", weekend: [6, 7], holidays: [] });
  await db.transaction((tx) => ensureMonthPartitions(tx, records, new Date(`${D}T00:00:00Z`), 1));
  const t = performance.now();
  await mk("file_inbox", N);
  await mk("db_snapshot", N);
  for (let i = 0; i < 13; i++) await mk("file_inbox", process.env.PERF_ALL ? N : 0);
  await db.transaction(async (tx) => { await tx.execute(sql`set local statement_timeout = 0`); await tx.execute(sql`analyze records`); await recountDays(tx, A); });
  console.log("seeded ms", Math.round(performance.now() - t));
  probe = await appRoleDb();
}, 600_000);
afterAll(async () => { await probe?.$client.close(); await truncateAll(); });

it("measures the detail (one source) and a list page (15)", async () => {
  const rest = process.env.PERF_ALL ? `${N} records each` : "no records";
  await time(`detail: file source, ${N} records`, [list[0]!]);
  await time(`detail: snapshot source, ${N} records`, [list[1]!]);
  await time(`list page: 15 sources, two of ${N} records, 13 of ${rest}`, list);
  await time(`list page: the 13 sources of ${rest}`, list.slice(2));
  expect([...(await withSpace({ spaceIds: [A], userId: null }, (tx) => sourceStates(tx, [list[0]!], A, NOW), probe)).values()][0]!.rowsToday).toBe(N);
}, 600_000);
});
