import { sql } from "drizzle-orm";
import type { Tx } from "./db";

/** PostgreSQL advisory lock keys (bigint), one per critical section, all here so no two sections share a key by accident. */
export const LOCKS = {
  /** db/migrate.ts: one migration runner at a time per database (session lock). */
  migrations: 7_340_211_001n,
  /** Permission catalog writes (POST /v1/permissions). */
  catalog: 50_001n,
  /** Changes that can lower the number of active Superadmins. */
  superadmin: 50_002n,
  /** The clean-up job: one instance at a time across API processes. */
  janitor: 50_003n,
  /** Changes that can lower the number of space_admin members of a space. */
  spaceAdmins: 50_004n,
  /** Adding monthly partitions to a domain table (kernel/partitions.ts): two callers never create one month at once. */
  partitions: 50_005n,
} as const;

export type LockName = keyof typeof LOCKS;

/** Takes lock `name` until `tx` commits or rolls back; a second taker waits. */
export async function xactLock(tx: Tx, name: LockName): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${LOCKS[name]})`);
}

/**
 * Two-key advisory locks (`pg_advisory_xact_lock(int, int)`): first key = the kind of object, second = a hash of its
 * id. PostgreSQL keeps the two-key space apart from the one-bigint space of LOCKS, so neither can collide with the other.
 */
const LOCK_KINDS = { config: 1, source: 2 } as const;

/**
 * Takes the lock of recon config `configId` until `tx` ends (spec §9 run tick, step 1): one config never runs twice at
 * once. Two configs whose ids hash alike (`hashtext`, 32 bits) wait on each other; they never run together wrongly.
 */
export async function configLock(tx: Tx, configId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_KINDS.config}::int, hashtext(${configId}))`);
}

/**
 * Takes the lock of source `sourceId` until `tx` ends: its ingest steps (a pull page, a file, a snapshot switch) run one
 * after the other, whichever queue they come from. Same hashing as configLock, in a kind of its own.
 */
export async function sourceLock(tx: Tx, sourceId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_KINDS.source}::int, hashtext(${sourceId}))`);
}
