// The imports module's job handlers, on the worker's pool (DEC-036). imports.beat: the worker's minute (schema.ts
// importHeartbeat), so the API can tell a running worker and a firing cron from neither (Monitoring's banner).
import { sql } from "drizzle-orm";
import type { Tx } from "../../kernel/db";
import type { JobHandler, QueueName } from "../../kernel/jobs";
import { importHeartbeat } from "./schema";

export const BEAT_KEY = "worker";

/** Writes the worker's minute. */
export async function beat(on: Tx): Promise<void> {
  await on.insert(importHeartbeat).values({ key: BEAT_KEY }).onConflictDoUpdate({ target: importHeartbeat.key, set: { at: sql`now()` } });
}

export function importsHandlers(on: Tx): Partial<Record<QueueName, JobHandler>> {
  return { "imports.beat": () => beat(on) };
}
