// ensureMonthPartitions on a test-only table partitioned by month of business_date (part_probe): it adds the missing
// months, is idempotent also when two callers run at once, works for the app role (which owns no table) and gives each
// partition the space policy.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { sql } from "drizzle-orm";
import { migrateJobs } from "../../../db/migrate";
import { asAppRole, partProbe } from "../../../../test/helpers/app-role";
import { functionsOf, holdTx, lockWaiters, partitionsOf } from "../../../../test/helpers/db";
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

  it("refuses a months count outside 1–24 and any parent but a range-partitioned table on business_date (date) with space_id", async () => {
    for (const n of [0, 25]) expect(await ensure("2026-11-01", n).catch((e: unknown) => e)).toBeInstanceOf(Error);
    const refused = (ddl: ReturnType<typeof sql>) => db.transaction(async (tx) => {
      await tx.execute(ddl);
      await tx.execute(sql`select recon_ensure_month_partitions('bad_probe'::regclass, '2026-11-01'::date, 1)`);
    }).then(() => "created", (e: unknown) => String((e as { cause?: unknown }).cause ?? e));
    const notDomain = "is not a domain table of its owner partitioned by range of business_date (date) with space_id";
    expect(await refused(sql`create temp table bad_probe (space_id uuid, business_date date) on commit drop`)).toContain(notDomain); // not partitioned
    expect(await refused(sql`create temp table bad_probe (space_id uuid, created_on date) partition by range (created_on) on commit drop`)).toContain(notDomain); // another key column
    expect(await refused(sql`create temp table bad_probe (space_id uuid, business_date timestamptz) partition by range (business_date) on commit drop`)).toContain(notDomain); // not a date
    expect(await refused(sql`create temp table bad_probe (ref text, business_date date) partition by range (business_date) on commit drop`)).toContain(notDomain); // no space_id
  });

  it("runs only for a role granted EXECUTE (db:migrate grants APP_DB_ROLE), with search_path pinned to pg_catalog, pg_temp", async () => {
    await client.unsafe(`do $$ begin
  begin create role recon_noexec_probe nologin nosuperuser nobypassrls; exception when duplicate_object or unique_violation then null; end;
  execute format('grant usage on schema %I to recon_noexec_probe', current_schema());
end $$`);
    await client`revoke execute on function recon_ensure_month_partitions(regclass, date, int) from recon_noexec_probe`;
    const call = () => db.transaction(async (tx) => {
      await tx.execute(sql`set local role recon_noexec_probe`);
      await ensureMonthPartitions(tx, partProbe, new Date("2029-01-01"), 1);
    }).then(() => "ok", (e: unknown) => errno(e));
    expect(await call()).toBe("42501"); // permission denied for function recon_ensure_month_partitions
    process.env.APP_DB_ROLE = "recon_noexec_probe";
    try {
      await migrateJobs();
    } finally {
      delete process.env.APP_DB_ROLE;
    }
    expect(await call()).toBe("ok");
    expect(await names()).toContain("part_probe_2029_01");
    expect(await functionsOf(["recon_enable_space_rls", "recon_ensure_month_partitions"])).toEqual([
      { proname: "recon_enable_space_rls", prosecdef: false, proconfig: ["search_path=pg_catalog, pg_temp"] },
      { proname: "recon_ensure_month_partitions", prosecdef: true, proconfig: ["search_path=pg_catalog, pg_temp"] },
    ]);
  }, 20_000);
});
