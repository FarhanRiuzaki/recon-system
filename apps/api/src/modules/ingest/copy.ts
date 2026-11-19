// The bulk writes of ingest (spike S1: stage, then INSERT … ON CONFLICT DO NOTHING). S1 staged with
// `COPY … FROM STDIN` (`sql.unsafe(…).writable()`), measured on Bun 1.4.4; on Bun 1.4.3, the version this repo pins
// (Dockerfile, CI), the query has no `writable()` ("q.writable is not a function", checked against the 1.4.3 binary
// on 2026-11-20), and the app role may not create the UNLOGGED staging table. So the fallback the plan allows: one
// multi-row INSERT … ON CONFLICT DO NOTHING per CHUNK rows, the chunk being the stage. Upgrade path: COPY into a temp
// table once the pinned Bun has it, measured against this.
//
// The only file of ingest with SQL written by hand (boundaries.test.ts allowlists it): the supersede UPDATE of mutable
// sources and the partition lookup. Values are bound; identifiers come from the declared tables. A batch never makes a
// partition: it throws MissingPartition, and the caller makes the month (makePartitions) outside its transaction and
// runs the step again.
import { getTableName, sql } from "drizzle-orm";
import type { InTx, Tx } from "../../kernel/db";
import { log } from "../../kernel/log";
import { ensureMonthPartitions } from "../../kernel/partitions";
import { quarantineRows, rawRows, records } from "./schema";

/** Rows per INSERT: records has 19 columns, so 1,000 rows bind 19,000 values (PostgreSQL's limit is 65,535). */
export const CHUNK = 1000;

const chunks = <T>(rows: T[]): T[][] => Array.from({ length: Math.ceil(rows.length / CHUNK) }, (_, i) => rows.slice(i * CHUNK, (i + 1) * CHUNK));

/** A batch needs months that raw_rows or records has no partition for yet; nothing was written for it. */
export class MissingPartition extends Error {
  constructor(readonly months: string[]) { super(`ingest: no partition for ${months.join(", ")}`); }
}

/**
 * Throws MissingPartition for the months of `dates` that raw_rows or records lacks. Never makes one here: creating a
 * partition takes ACCESS EXCLUSIVE on the parent until the transaction ends, and an ingest transaction (a whole file)
 * can be long. Looked up per batch (no process cache: a partition made in a transaction that rolled back is gone).
 */
async function checkMonths(tx: InTx, dates: Iterable<string>): Promise<void> {
  const missing: string[] = [];
  for (const month of new Set([...dates].map((d) => d.slice(0, 7)))) {
    const names = [rawRows, records].map((t) => `${getTableName(t)}_${month.replace("-", "_")}`);
    const [r] = (await tx.execute(sql`select to_regclass(${names[0]}) is not null and to_regclass(${names[1]}) is not null as ok`)) as unknown as { ok: boolean }[];
    if (!r?.ok) missing.push(month);
  }
  if (missing.length) throw new MissingPartition(missing);
}

/**
 * The fallback for a month maintenance.partitions hasn't made (an old date sent late): makes it in a short transaction
 * of its own, waiting at most 5 s for the parent's lock (a long reader makes it fail and the job retry), then logs it.
 */
export async function makePartitions(on: Tx, months: string[]): Promise<void> {
  await on.transaction(async (tx) => {
    await tx.execute(sql`select set_config('lock_timeout', '5s', true)`);
    for (const m of months) {
      for (const t of [rawRows, records]) await ensureMonthPartitions(tx, t, new Date(`${m}-01T00:00:00Z`), 1);
    }
  });
  log.warn({ months }, "partitions made during ingest: maintenance.partitions had not made them");
}

/**
 * Writes one batch: raw rows and records once per dedup key (a row already stored is dropped), quarantined lines all.
 * Answers the records it added.
 */
export async function insertBatch(
  tx: InTx, raw: (typeof rawRows.$inferInsert)[], recs: (typeof records.$inferInsert)[], quarantine: (typeof quarantineRows.$inferInsert)[],
): Promise<{ id: string; naturalKey: string | null }[]> {
  await checkMonths(tx, recs.map((r) => r.businessDate));
  for (const c of chunks(raw)) await tx.insert(rawRows).values(c).onConflictDoNothing();
  const added: { id: string; naturalKey: string | null }[] = [];
  for (const c of chunks(recs)) added.push(...await tx.insert(records).values(c).onConflictDoNothing().returning({ id: records.id, naturalKey: records.naturalKey }));
  for (const c of chunks(quarantine)) await tx.insert(quarantineRows).values(c);
  return added;
}

/**
 * Mutable sources: each `latest` record replaces the current records of its natural key (superseded_by = it). Answers
 * the ids replaced.
 */
export async function supersede(tx: InTx, spaceId: string, sourceId: string, latest: { key: string; id: string }[]): Promise<string[]> {
  if (!latest.length) return [];
  const rows = (await tx.execute(sql`update ${records} set superseded_by = v.id
    from jsonb_to_recordset(${JSON.stringify(latest)}::text::jsonb) as v(key text, id uuid)
    where ${records.spaceId} = ${spaceId} and ${records.sourceId} = ${sourceId} and ${records.naturalKey} = v.key
      and ${records.supersededBy} is null and ${records.id} <> v.id
    returning ${records.id} as id`)) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}
