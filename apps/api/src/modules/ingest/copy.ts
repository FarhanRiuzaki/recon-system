// The bulk writes of ingest (spike S1: stage, then INSERT … ON CONFLICT DO NOTHING). S1 staged with
// `COPY … FROM STDIN` (`sql.unsafe(…).writable()`), measured on Bun 1.4.4; on Bun 1.4.3, the version this repo pins
// (Dockerfile, CI), the query has no `writable()` ("q.writable is not a function", checked against the 1.4.3 binary
// on 2026-11-20), and the app role may not create the UNLOGGED staging table. So the fallback the plan allows: one
// multi-row INSERT … ON CONFLICT DO NOTHING per CHUNK rows, the chunk being the stage. Upgrade path: COPY into a temp
// table once the pinned Bun has it, measured against this.
//
// The only file of ingest with SQL written by hand (boundaries.test.ts allowlists it): the supersede UPDATE of mutable
// sources and the partition lookup. Values are bound; identifiers come from the declared tables.
import { getTableName, sql } from "drizzle-orm";
import type { InTx } from "../../kernel/db";
import { log } from "../../kernel/log";
import { ensureMonthPartitions } from "../../kernel/partitions";
import { quarantineRows, rawRows, records } from "./schema";

/** Rows per INSERT: records has 19 columns, so 1,000 rows bind 19,000 values (PostgreSQL's limit is 65,535). */
export const CHUNK = 1000;

const chunks = <T>(rows: T[]): T[][] => Array.from({ length: Math.ceil(rows.length / CHUNK) }, (_, i) => rows.slice(i * CHUNK, (i + 1) * CHUNK));

/** Partitions this process has seen; a month missing from it is looked up once. */
const known = new Set<string>();

/**
 * Makes sure raw_rows and records have the month of each date. maintenance.partitions makes them ahead (creating one
 * locks the parent for the rest of the transaction); a month it hasn't made (an old date sent late) is made here, and
 * logged, as the fallback.
 */
async function ensureMonths(tx: InTx, dates: Iterable<string>): Promise<void> {
  for (const month of new Set([...dates].map((d) => d.slice(0, 7)))) {
    for (const t of [rawRows, records]) {
      const name = `${getTableName(t)}_${month.replace("-", "_")}`;
      if (known.has(name)) continue;
      const [r] = (await tx.execute(sql`select to_regclass(${name}) is not null as ok`)) as unknown as { ok: boolean }[];
      if (!r?.ok) {
        log.warn({ partition: name }, "partition made during ingest: maintenance.partitions had not made it");
        await ensureMonthPartitions(tx, t, new Date(`${month}-01T00:00:00Z`), 1);
      }
      known.add(name);
    }
  }
}

/**
 * Writes one batch: raw rows and records once per dedup key (a row already stored is dropped), quarantined lines all.
 * Answers the records it added.
 */
export async function insertBatch(
  tx: InTx, raw: (typeof rawRows.$inferInsert)[], recs: (typeof records.$inferInsert)[], quarantine: (typeof quarantineRows.$inferInsert)[],
): Promise<{ id: string; naturalKey: string | null }[]> {
  await ensureMonths(tx, recs.map((r) => r.businessDate));
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
