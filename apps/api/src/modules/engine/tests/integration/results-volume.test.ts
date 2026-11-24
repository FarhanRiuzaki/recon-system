// Operation result at volume (spec "Rulings after the builder check", Volume test): one recon with 200,000 results on
// one business date (three in four an auto pair, the rest a lone break), then 30,000 a date over 31 dates (930,000):
// page 1 and the deepest page sorted by status, and the counts, each through the API (its pool's 5 s statement
// timeout, row level security) and under 5 s. Off unless RESULTS_VOLUME (it seeds millions of rows):
//   RESULTS_VOLUME=1 bun test src/modules/engine/tests/integration/results-volume.test.ts
import { describe, expect, it } from "bun:test";
import type { Page } from "@starterkit/shared/contracts/common";
import type { ResultCountsDto, ResultRowDto } from "@starterkit/shared/contracts/results";
import { eq, sql } from "drizzle-orm";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { db } from "../../../../kernel/db";
import { ensureMonthPartitions } from "../../../../kernel/partitions";
import { records } from "../../../ingest";
import { spaceMembers, spaces } from "../../../spaces";
import { users } from "../../../users";
import { reconItems } from "../../schema";
import { makeSource, plainSource, recon, spec } from "../fixtures";

const A = Bun.randomUUIDv7();
const dateOf = (first: string, i: number) => new Date(Date.parse(`${first}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);

/** `n` results of `cfg` on date `d`: pairs 1..¾n (records P<g>/Q<g>, an auto group each), breaks past that (P<g> alone). */
async function seed(src: { a: { sourceId: string; versionId: string }; b: { sourceId: string; versionId: string } }, cfg: { configId: string; versionId: string }, d: string, n: number) {
  const pairs = Math.floor((n * 3) / 4);
  for (let from = 1; from <= n; from += 100_000) {
    const to = Math.min(n, from + 99_999), pairTo = Math.min(pairs, to);
    const rec = (s: "a" | "b", source: { sourceId: string; versionId: string }, upTo: number) => db.execute(sql`insert into records (id, space_id, source_id, source_version_id, business_date, bday_index, ext_ref, amount_minor, currency, attrs, row_hash, origin_id)
      select md5('r' || ${s} || ${d} || g)::uuid, ${A}::uuid, ${source.sourceId}::uuid, ${source.versionId}::uuid, ${d}::date, 1, ${s === "a" ? "P" : "Q"} || g, 1000 + g, 'IDR', '{}'::jsonb, md5(${s} || g), ${source.versionId}::uuid
      from generate_series(${from}::int, ${upTo}::int) g`);
    const item = (s: "a" | "b", upTo: number) => db.execute(sql`insert into recon_items (id, space_id, config_id, record_id, side, status, business_date, break_reason)
      select md5('i' || ${s} || ${d} || g)::uuid, ${A}::uuid, ${cfg.configId}::uuid, md5('r' || ${s} || ${d} || g)::uuid, ${s}, case when g <= ${pairs} then 'matched' else 'break' end, ${d}::date,
        case when g <= ${pairs} then null else 'No counterpart' end
      from generate_series(${from}::int, ${upTo}::int) g`);
    await rec("a", src.a, to);
    await item("a", to);
    if (from > pairs) continue;
    await rec("b", src.b, pairTo);
    await item("b", pairTo);
    await db.execute(sql`insert into match_groups (id, space_id, config_id, config_version_id, pass_no, kind, business_date, evidence)
      select md5('g' || ${d} || g)::uuid, ${A}::uuid, ${cfg.configId}::uuid, ${cfg.versionId}::uuid, 1, 'auto', ${d}::date, '{}'::jsonb from generate_series(${from}::int, ${pairTo}::int) g`);
    for (const s of ["a", "b"]) {
      await db.execute(sql`insert into match_members (group_id, space_id, item_id, side, signed_amount)
        select md5('g' || ${d} || g)::uuid, ${A}::uuid, md5('i' || ${s} || ${d} || g)::uuid, ${s}, 1000 + g from generate_series(${from}::int, ${pairTo}::int) g`);
    }
  }
}

async function setUp(first: string, days: number, perDay: number) {
  await resetData();
  await db.delete(spaces);
  await db.insert(spaces).values({ id: A, code: "vol", name: "Volume" });
  const [viewer] = await db.select({ id: users.id }).from(users).where(eq(users.username, "viewer"));
  await db.insert(spaceMembers).values({ spaceId: A, userId: viewer!.id, role: "operator" });
  await db.transaction(async (tx) => {
    await ensureMonthPartitions(tx, records, new Date(`${first}T00:00:00Z`), 2);
    await ensureMonthPartitions(tx, reconItems, new Date(`${first}T00:00:00Z`), 2);
  });
  const src = { a: await makeSource(A, plainSource()), b: await makeSource(A, plainSource()) };
  const cfg = await recon(A, spec(src.a.sourceId, src.b.sourceId, [{ no: 1, name: "Exact", cardinality: "1:1", blocking: ["ext_ref"], accept: "auto", on_ambiguous: "break", predicates: [{ op: "eq", field: "amount_minor" }] }]));
  const t0 = performance.now();
  for (let i = 0; i < days; i++) await seed(src, cfg, dateOf(first, i), perDay);
  // as autovacuum would have some time after the runs
  await db.execute(sql`analyze records, recon_items, match_groups, match_members`);
  console.log(`seeded ${days} × ${perDay} results in ${Math.round(performance.now() - t0)} ms`);
  return { cfg: cfg.configId, token: await signIn("viewer") };
}

/** One read through the API, timed; 200 and under the 5 s statement timeout. */
async function timed<T>(label: string, path: string, token: string): Promise<T> {
  const t = performance.now();
  const r = await call("GET", path, { token });
  const ms = Math.round(performance.now() - t);
  console.log(`${label}: ${ms} ms (${r.status})`);
  expect(r.status).toBe(200);
  expect(ms).toBeLessThan(5000);
  return (await r.json()) as T;
}

async function reads(cfg: string, token: string, from: string, to: string, total: number) {
  const base = `/v1/spaces/${A}/recons/${cfg}/results`, range = `dateFrom=${from}&dateTo=${to}`;
  const first = await timed<Page<ResultRowDto>>("page 1 by status", `${base}?${range}&sort=status`, token);
  expect(first.items[0]!.status).toBe("matched");
  const deepest = Math.min(1000, Math.ceil(Math.min(total, 100_000) / 100));
  const deep = await timed<Page<ResultRowDto>>(`page ${deepest} of 100 by status`, `${base}?${range}&sort=status&page=${deepest}&pageSize=100`, token);
  expect(deep.items.length).toBeGreaterThan(0);
  await timed<Page<ResultRowDto>>("page 1 by business date", `${base}?${range}`, token);
  const found = await timed<Page<ResultRowDto>>("reference search", `${base}?${range}&q=P12345`, token);
  expect(found.total).toBeGreaterThan(0);
  const c = await timed<ResultCountsDto>("counts", `${base}/counts?${range}`, token);
  if (!c.capped) expect((c.counts.matched ?? 0) + (c.counts.unmatch ?? 0)).toBe(total);
}

describe.if(!!process.env.RESULTS_VOLUME)("Operation result at volume", () => {
  it("200,000 results on one business date", async () => {
    const { cfg, token } = await setUp("2026-10-01", 1, 200_000);
    await reads(cfg, token, "2026-10-01", "2026-10-01", 200_000);
  }, 900_000);

  it("30,000 results a date over 31 dates", async () => {
    const { cfg, token } = await setUp("2026-10-01", 31, 30_000);
    await reads(cfg, token, "2026-10-01", "2026-10-31", 930_000);
  }, 1_800_000);
});
