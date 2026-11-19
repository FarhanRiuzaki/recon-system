import { getTableName, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { Tx } from "./db";
import { xactLock } from "./locks";

/**
 * Makes sure `table` (a domain table partitioned by range of business_date, declared in a module's schema.ts) has a
 * partition for each of `months` months (1–24) from the month of `from` in UTC (a business date parsed from
 * "YYYY-MM-DD" is UTC midnight); the months already there stay as they are. Called by the daily
 * `maintenance.partitions` job and before an ingest writes a new business date.
 *
 * The DDL runs in recon_ensure_month_partitions (drizzle/0009_domain_tables.sql), as the table's owner: the app role
 * has DML only and PostgreSQL lets only the owner add a partition. The table name comes from the declared table, never
 * from a request, and reaches PostgreSQL as a bound value cast to regclass; the function builds every identifier
 * itself. The `partitions` lock serializes callers, so two at once both succeed.
 */
export async function ensureMonthPartitions(tx: Tx, table: PgTable, from: Date, months: number): Promise<void> {
  const first = `${from.getUTCFullYear()}-${String(from.getUTCMonth() + 1).padStart(2, "0")}-01`;
  await xactLock(tx, "partitions");
  await tx.execute(sql`select recon_ensure_month_partitions(${getTableName(table)}::regclass, ${first}::date, ${months}::int)`);
}
