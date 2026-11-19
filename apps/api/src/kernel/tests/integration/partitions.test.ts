// ensureMonthPartitions on a test-only table partitioned by month of business_date (part_probe): it adds the missing
// months, is idempotent also when two callers run at once, works for the app role (which owns no table) and gives each
// partition the space policy.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { asAppRole, partProbe } from "../../../../test/helpers/app-role";
import { holdTx, lockWaiters, partitionsOf } from "../../../../test/helpers/db";
import { client, db, type Tx } from "../../db";
import { xactLock } from "../../locks";
import { ensureMonthPartitions } from "../../partitions";

const A = Bun.randomUUIDv7();
const errno = (e: unknown) => ((e as { cause?: { errno?: string } }).cause ?? (e as { errno?: string })).errno;

const partitions = () => partitionsOf("part_probe");
const names = async () => (await partitions()).map((p) => p.name);
const ensure = (from: string, months: number) => db.transaction((tx) => ensureMonthPartitions(tx, partProbe, new Date(from), months));

beforeAll(async () => {
  await client`drop table if exists part_probe`;
  await client`create table part_probe (space_id uuid not null, ref text not null, business_date date not null, unique (space_id, ref, business_date)) partition by range (business_date)`;
  await client`select recon_enable_space_rls('part_probe')`;
});
afterAll(async () => {
  await client`drop table if exists part_probe`;
});

describe("ensureMonthPartitions", () => {
  it("adds the missing months from the month of `from` (UTC) and leaves the ones there; each partition gets the space policy", async () => {
    await ensure("2026-11-19", 2);
    expect(await names()).toEqual(["part_probe_2026_11", "part_probe_2026_12"]);
    await ensure("2026-12-31T23:00:00Z", 2); // December again, then January
    expect(await partitions()).toEqual(["2026_11", "2026_12", "2027_01"].map((m) => ({ name: `part_probe_${m}`, rls: true, force: true, policies: 1 })));
  });

  it("two callers at once both succeed and make each month once", async () => {
    const holder = await holdTx((tx) => xactLock(tx, "partitions"));
    let waited = false;
    let both: unknown[];
    try {
      const run = Promise.all([ensure("2027-02-01", 3), ensure("2027-03-01", 2)].map((p) => p.then(() => "ok", (e: unknown) => e)));
      waited = await lockWaiters(2, "%pg_advisory_xact_lock%");
      await holder.commit();
      both = await run;
    } finally {
      await holder.rollback();
    }
    expect(waited).toBe(true);
    expect(both).toEqual(["ok", "ok"]);
    expect((await names()).filter((n) => n >= "part_probe_2027_02")).toEqual(["part_probe_2027_02", "part_probe_2027_03", "part_probe_2027_04"]);
  });

  it("the app role (no table of its own) adds a month and writes a row into it through the parent; a month without a partition refuses the row", async () => {
    // the scope withSpace (modules/spaces) sets; kernel tests don't import modules
    const write = (day: string, ensureFirst: boolean) => db.transaction(async (tx: Tx) => {
      await tx.execute(sql`select set_config('app.space_ids', ${A}, true)`);
      await asAppRole(tx);
      expect(await tx.execute(sql`select current_user as u`)).toEqual([{ u: "recon_app_probe" }]);
      if (ensureFirst) await ensureMonthPartitions(tx, partProbe, new Date(day), 1);
      await tx.insert(partProbe).values({ spaceId: A, ref: "r1", businessDate: day });
      return (await tx.select().from(partProbe)).length;
    });
    const missing = await write("2028-01-15", false).catch((e: unknown) => e);
    expect(errno(missing)).toBe("23514"); // no partition of relation "part_probe" found for row
    expect(await write("2028-01-15", true)).toBe(1);
    expect(await names()).toContain("part_probe_2028_01");
  });

  it("refuses a months count outside 1–24 and a table that is not partitioned by range", async () => {
    for (const n of [0, 25]) expect(await ensure("2026-11-01", n).catch((e: unknown) => e)).toBeInstanceOf(Error);
    const e = await db.transaction(async (tx) => {
      await tx.execute(sql`create temp table plain_probe (space_id uuid, business_date date) on commit drop`);
      await tx.execute(sql`select recon_ensure_month_partitions('plain_probe'::regclass, '2026-11-01'::date, 1)`);
    }).catch((e: unknown) => e);
    expect(e).toBeInstanceOf(Error);
  });
});
