// Operation result at volume (spec "Rulings after the builder check", Volume test): one recon with 200,000 results on
// one business date (three in four an auto pair, the rest a lone break), then 30,000 a date over 31 dates (930,000),
// with requests and posting runs on a break in four (grouped ones too): page 1 and the deepest page sorted by status,
// page 1 by date, by amount A and by reference, a reference search, a status filter and the counts, each through the
// API (its pool's 5 s statement timeout, row level security) and under 5 s. Off unless RESULTS_VOLUME (it seeds
// millions of rows; run it on a fresh test database, a reset of 930,000 rows outlasts the timeout):
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
import { budget } from "../../../../../test/helpers/perf";

const A = Bun.randomUUIDv7();
const dateOf = (first: string, i: number) => new Date(Date.parse(`${first}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10);

/** `n` results of `cfg` on date `d`: pairs 1..¾n (records P<g>/Q<g>, an auto group each), breaks past that (P<g> alone). */
async function seed(src: { a: { sourceId: string; versionId: string }; b: { sourceId: string; versionId: string } }, cfg: { configId: string; versionId: string }, d: string, n: number) {
  const pairs = Math.floor((n * 3) / 4);
  for (let from = 1; from <= n; from += 100_000) {
    const to = Math.min(n, from + 99_999), pairTo = Math.min(pairs, to);
    const rec = (s: "a" | "b", source: { sourceId: string; versionId: string }, upTo: number) => db.execute(sql`insert into records (id, space_id, source_id, source_version_id, business_date, bday_index, ext_ref, amount_minor, currency, attrs, row_hash, origin_id)
      select left(encode(sha256(convert_to('r' || ${s} || ${d} || g, 'UTF8')), 'hex'), 32)::uuid, ${A}::uuid, ${source.sourceId}::uuid, ${source.versionId}::uuid, ${d}::date, 1, ${s === "a" ? "P" : "Q"} || g, 1000 + g, 'IDR', '{}'::jsonb, left(encode(sha256(convert_to(${s} || g, 'UTF8')), 'hex'), 32), ${source.versionId}::uuid
      from generate_series(${from}::int, ${upTo}::int) g`);
    const item = (s: "a" | "b", upTo: number) => db.execute(sql`insert into recon_items (id, space_id, config_id, record_id, side, status, business_date, break_reason)
      select left(encode(sha256(convert_to('i' || ${s} || ${d} || g, 'UTF8')), 'hex'), 32)::uuid, ${A}::uuid, ${cfg.configId}::uuid, left(encode(sha256(convert_to('r' || ${s} || ${d} || g, 'UTF8')), 'hex'), 32)::uuid, ${s}, case when g <= ${pairs} then 'matched' else 'break' end, ${d}::date,
        case when g <= ${pairs} then null else 'No counterpart' end
      from generate_series(${from}::int, ${upTo}::int) g`);
    await rec("a", src.a, to);
    await item("a", to);
    if (from > pairs) continue;
    await rec("b", src.b, pairTo);
    await item("b", pairTo);
    await db.execute(sql`insert into match_groups (id, space_id, config_id, config_version_id, pass_no, kind, business_date, evidence)
      select left(encode(sha256(convert_to('g' || ${d} || g, 'UTF8')), 'hex'), 32)::uuid, ${A}::uuid, ${cfg.configId}::uuid, ${cfg.versionId}::uuid, 1, 'auto', ${d}::date, '{}'::jsonb from generate_series(${from}::int, ${pairTo}::int) g`);
    for (const s of ["a", "b"]) {
      await db.execute(sql`insert into match_members (group_id, space_id, item_id, side, signed_amount)
        select left(encode(sha256(convert_to('g' || ${d} || g, 'UTF8')), 'hex'), 32)::uuid, ${A}::uuid, left(encode(sha256(convert_to('i' || ${s} || ${d} || g, 'UTF8')), 'hex'), 32)::uuid, ${s}, 1000 + g from generate_series(${from}::int, ${pairTo}::int) g`);
    }
  }
  await requests(cfg, d, pairs + 1, n);
}

/**
 * The breaks' requests and posting runs, as a posting approval writes them: every 4th break a request (every 8th of
 * those a force match holding the next break too, every 12th an older rejected one before it), its own posting run
 * (failed, queued or posted), every 7th one more run for the whole request, every 5th a grouped posting (one group a date).
 */
async function requests(cfg: { configId: string; versionId: string }, d: string, from: number, to: number) {
  const rq = (tag: string) => sql`left(encode(sha256(convert_to(${tag} || ${d} || g, 'UTF8')), 'hex'), 32)::uuid`, item = sql`left(encode(sha256(convert_to('ia' || ${d} || g, 'UTF8')), 'hex'), 32)::uuid`, next = sql`left(encode(sha256(convert_to('ia' || ${d} || (g + 1), 'UTF8')), 'hex'), 32)::uuid`;
  const each = sql`from generate_series(${from}::int, ${to}::int) g where g % 4 = 0`;
  await db.execute(sql`insert into approval_requests (id, space_id, config_id, kind, item_id, item_ids, label, note, status, config_version_id, requested_at)
    select ${rq("q")}, ${A}::uuid, ${cfg.configId}::uuid, case when g % 32 = 0 then 'force_match' else 'posting' end, ${item}, case when g % 32 = 0 then array[${next}] else '{}'::uuid[] end,
      'Post', 'n', 'approved', ${cfg.versionId}::uuid, now() ${each}`);
  await db.execute(sql`insert into approval_requests (id, space_id, config_id, kind, item_id, label, note, status, config_version_id, requested_at)
    select ${rq("o")}, ${A}::uuid, ${cfg.configId}::uuid, 'posting', ${item}, 'Post', 'n', 'rejected', ${cfg.versionId}::uuid, now() - interval '1 day' ${each} and g % 48 = 0`);
  await db.execute(sql`insert into action_runs (id, space_id, request_id, config_version_id, action_index, action_name, kind, event, item_id, seq, status, bank_reference)
    select left(encode(sha256(convert_to('r' || ${d} || g, 'UTF8')), 'hex'), 32)::uuid, ${A}::uuid, ${rq("q")}, ${cfg.versionId}::uuid, 0, 'Post', 'posting', 'approved', ${item}, 1,
      case g % 3 when 0 then 'failed' when 1 then 'queued' else 'posted' end, 'BR' || g ${each}`);
  await db.execute(sql`insert into action_runs (id, space_id, request_id, config_version_id, action_index, action_name, kind, event, item_id, seq, status)
    select left(encode(sha256(convert_to('w' || ${d} || g, 'UTF8')), 'hex'), 32)::uuid, ${A}::uuid, ${rq("q")}, ${cfg.versionId}::uuid, 1, 'Post once', 'posting', 'approved', null, 2, 'posted' ${each} and g % 28 = 8`);
  const pg = Bun.randomUUIDv7();
  await db.execute(sql`insert into posting_groups (id, space_id, config_id, config_version_id, change, action_index, variant_index, action_name, variant_name, keys, key_text, currency, period, at)
    values (${pg}::uuid, ${A}::uuid, ${cfg.configId}::uuid, ${cfg.versionId}::uuid, 'posting', 2, 0, 'Post daily', 'Daily', '[]'::jsonb, ${d}, 'IDR', ${d}::date, 'day_close')`);
  await db.execute(sql`insert into posting_group_items (group_id, space_id, request_id, action_index, item_id, ref, amount_minor)
    select ${pg}::uuid, ${A}::uuid, ${rq("q")}, 2, ${item}, 'P' || g, 1000 + g ${each} and g % 20 = 0`);
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
  await db.execute(sql`analyze records, recon_items, match_groups, match_members, approval_requests, action_runs, posting_groups, posting_group_items`);
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
  expect(ms).toBeLessThan(budget(5000));
  return (await r.json()) as T;
}

async function reads(cfg: string, token: string, from: string, to: string, total: number) {
  const base = `/v1/spaces/${A}/recons/${cfg}/results`, range = `dateFrom=${from}&dateTo=${to}`;
  const first = await timed<Page<ResultRowDto>>("page 1 by status", `${base}?${range}&sort=status`, token);
  expect(first.items[0]!.status).toBe("posting_failed");
  const deepest = Math.min(1000, Math.ceil(Math.min(total, 100_000) / 100));
  const deep = await timed<Page<ResultRowDto>>(`page ${deepest} of 100 by status`, `${base}?${range}&sort=status&page=${deepest}&pageSize=100`, token);
  expect(deep.items.length).toBeGreaterThan(0);
  await timed<Page<ResultRowDto>>("page 1 by business date", `${base}?${range}`, token);
  const found = await timed<Page<ResultRowDto>>("reference search", `${base}?${range}&q=P12345`, token);
  expect(found.total).toBeGreaterThan(0);
  await timed<Page<ResultRowDto>>("page 1 by amount A", `${base}?${range}&sort=-amountA`, token);
  await timed<Page<ResultRowDto>>("page 1 by reference", `${base}?${range}&sort=ref`, token);
  await timed<Page<ResultRowDto>>("posting failed by status", `${base}?${range}&result=posting_failed&sort=status`, token);
  const c = await timed<ResultCountsDto>("counts", `${base}/counts?${range}`, token);
  if (!c.capped) expect(Object.values(c.counts).reduce((n, x) => n + x, 0)).toBe(total);
  expect(c.counts.posting_failed ?? 0).toBeGreaterThan(0);
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
