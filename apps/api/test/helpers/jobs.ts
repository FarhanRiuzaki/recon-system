// Job kernel tests (src/kernel/tests/integration/jobs.test.ts and the worker subprocess it kills): an effect table and
// a done-marker table in their own schema, so the subprocess sees them and the table-owner check never does.
import { sql } from "drizzle-orm";
import { pgSchema, text } from "drizzle-orm/pg-core";
import type { Tx } from "../../src/kernel/db";

const probe = pgSchema("jobs_probe");
export const effects = probe.table("effect", { key: text("key").notNull() });
export const doneMarks = probe.table("done", { key: text("key").primaryKey() });

/** Creates the probe schema empty (drops an old one first). */
export async function resetProbe(db: Tx): Promise<void> {
  await db.execute(sql.raw(`drop schema if exists jobs_probe cascade;
create schema jobs_probe;
create table jobs_probe.effect (key text not null);
create table jobs_probe.done (key text primary key);`));
}

export async function dropProbe(db: Tx): Promise<void> {
  await db.execute(sql.raw("drop schema if exists jobs_probe cascade"));
}

/**
 * The idempotent step of spec §9: the effect and its done marker commit in one transaction, and a second run of the
 * same key (a retry after the worker died past the commit) finds the marker and writes nothing.
 */
export async function applyOnce(db: Tx, key: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [first] = await tx.insert(doneMarks).values({ key }).onConflictDoNothing().returning();
    if (first) await tx.insert(effects).values({ key });
  });
}
