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
const LOCK_KINDS = { config: 1, source: 2, sourceFields: 3, connectorToken: 4, postingGroups: 5 } as const;

/**
 * Takes the lock of recon config `configId` until `tx` ends (spec §9 run tick, step 1): one config never runs twice at
 * once. Two configs whose ids hash alike (`hashtext`, 32 bits) wait on each other; they never run together wrongly.
 */
export async function configLock(tx: Tx, configId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_KINDS.config}::int, hashtext(${configId}))`);
}

/** configLock without waiting: true when taken (until `tx` ends), false while another transaction holds it. */
export async function tryConfigLock(tx: Tx, configId: string): Promise<boolean> {
  const [r] = (await tx.execute(sql`select pg_try_advisory_xact_lock(${LOCK_KINDS.config}::int, hashtext(${configId})) as ok`)) as unknown as { ok: boolean }[];
  return r!.ok;
}

/**
 * Takes the lock of source `sourceId` until `tx` ends: its ingest steps (a pull page, a file, a snapshot switch) run one
 * after the other, whichever queue they come from. Same hashing as configLock, in a kind of its own.
 */
export async function sourceLock(tx: Tx, sourceId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_KINDS.source}::int, hashtext(${sourceId}))`);
}

/**
 * Takes the lock of the fields published recons read from source `sourceId` (Plan 3 A4) until `tx` ends: publishing a
 * recon on the source and checking a source version against those fields run one after the other, never both on a stale
 * view. A kind of its own, so it never waits behind the source's ingest steps (sourceLock).
 */
export async function sourceFieldsLock(tx: Tx, sourceId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_KINDS.sourceFields}::int, hashtext(${sourceId}))`);
}

/** Takes the token lock of a connector's environment (`key` = "<connector id>:<environment>") until `tx` ends: one token request at a time. */
export async function connectorTokenLock(tx: Tx, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_KINDS.connectorToken}::int, hashtext(${key}))`);
}

/**
 * Takes the posting groups lock of recon config `configId` until `tx` ends (stage 5, review I2): shared while an
 * approval joins a group (approvals never wait on each other), exclusive while groups close, so a day close never
 * misses a group an approval opened meanwhile, and a joiner waiting on it sees the day as closing. A kind of its own:
 * never the run lock (configLock), which a whole run holds.
 */
export async function postingGroupsLock(tx: Tx, configId: string, mode: "shared" | "exclusive"): Promise<void> {
  await tx.execute(mode === "shared"
    ? sql`select pg_advisory_xact_lock_shared(${LOCK_KINDS.postingGroups}::int, hashtext(${configId}))`
    : sql`select pg_advisory_xact_lock(${LOCK_KINDS.postingGroups}::int, hashtext(${configId}))`);
}
