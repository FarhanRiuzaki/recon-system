// deliveryCounts on a dashboard's worst period: SOURCES sources (half file inbox, half snapshot) × 92 days, every date
// delivered, as the app role (row level security on). Rows are written by SQL. It stays inside a time budget: the
// rows are read by (space_id, source_id) and grouped by source once, never filtered per source and date.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { SourceSpec } from "@starterkit/shared/contracts/sources";
import { sql } from "drizzle-orm";
import { appRoleDb } from "../../../../../test/helpers/app-role";
import { truncateAll } from "../../../../../test/helpers/db";
import { db } from "../../../../kernel/db";
import { calendars, sources, sourceVersions } from "../../../sources";
import { spaces, withSpace } from "../../../spaces";
import { type DeliverySource, deliveryCounts } from "../../service";
import { ksei } from "../unit/fixtures";

const A = Bun.randomUUIDv7();
const SOURCES = 2000, FROM = "2026-08-01", TO = "2026-10-31"; // 92 days
const NOW = new Date("2026-11-20T00:00:00Z");
const list: DeliverySource[] = [];
let probe: Awaited<ReturnType<typeof appRoleDb>>;

describe("deliveryCounts: many sources × 92 days", () => {
  beforeAll(async () => {
    await truncateAll();
    await db.insert(spaces).values({ id: A, code: "perf", name: "Perf" });
    await db.insert(calendars).values({ id: Bun.randomUUIDv7(), code: "id-default", name: "Default", weekend: [6, 7], holidays: [] });
    const file = { ...ksei(), health: { deadline: "09:00" } } as SourceSpec;
    const snap = { ...file, input: { kind: "db_snapshot", query: "select 1 where :business_date is not null", schedule: "0 6 * * *" } } as SourceSpec;
    const createdAt = new Date("2026-07-01T00:00:00Z");
    for (let i = 0; i < SOURCES; i++) {
      const spec = i % 2 ? snap : file;
      list.push({ id: Bun.randomUUIDv7(), spaceId: A, kind: spec.input.kind, spec, createdAt });
    }
    await db.insert(sources).values(list.map((x) => ({ id: x.id, spaceId: A, code: `p-${x.id.slice(-12)}`, name: "P", kind: x.kind, createdAt })));
    await db.insert(sourceVersions).values(list.map((x) => ({ id: Bun.randomUUIDv7(), spaceId: A, sourceId: x.id, version: 1, status: "published", spec: x.spec, specHash: "h", makerId: A, publishedAt: createdAt })));
    const files = list.filter((x) => x.kind === "file_inbox").map((x) => x.id), snaps = list.filter((x) => x.kind === "db_snapshot").map((x) => x.id);
    const days = sql`generate_series(${FROM}::date, ${TO}::date, '1 day') d`;
    await db.transaction(async (tx) => {
      await tx.execute(sql`insert into source_deliveries (space_id, source_id, business_date, completed_at)
        select ${A}::uuid, s, d::date, d + interval '1 day 8 hours' from unnest(${`{${list.map((x) => x.id).join(",")}}`}::uuid[]) s, ${days}`);
      await tx.execute(sql`insert into source_files (id, space_id, source_id, name, sha256, size, modified_at, status, business_date, rows_ok)
        select gen_random_uuid(), ${A}::uuid, s, 'f' || to_char(d, 'YYYYMMDD'), md5(s::text || d::text), 1, d, 'ingested', d::date, 1 from unnest(${`{${files.join(",")}}`}::uuid[]) s, ${days}`);
      await tx.execute(sql`insert into source_snapshots (id, space_id, source_id, business_date, status, rows)
        select gen_random_uuid(), ${A}::uuid, s, d::date, 'active', 1 from unnest(${`{${snaps.join(",")}}`}::uuid[]) s, ${days}`);
      await tx.execute(sql`analyze source_deliveries, source_files, source_snapshots`);
    });
    probe = await appRoleDb();
  }, 120_000);
  afterAll(async () => { await probe?.$client.close(); await truncateAll(); });

  it(`${SOURCES} sources × 92 days in under 2 s, every business date counted`, async () => {
    const t = performance.now();
    const out = await withSpace({ spaceIds: [A], userId: null }, (tx) => deliveryCounts(tx, list, FROM, TO, NOW), probe);
    const ms = performance.now() - t;
    expect(out.size).toBe(SOURCES);
    expect(out.get(list[0]!.id)).toEqual({ onTime: 65, late: 0, missing: 0, unknown: 0 }); // the 65 weekdays of Aug–Oct 2026
    expect(ms).toBeLessThan(2000);
  }, 60_000);
});
