// The janitor's part of the imports module: run and check log rows past AUDIT_RETENTION_DAYS, oldest first, a batch per
// table per run (as the activity log's purge).
import { inArray, lt, sql } from "drizzle-orm";
import { config } from "../../kernel/config";
import type { Tx } from "../../kernel/db";
import { importChecks, importRuns } from "./schema";

const PURGE_BATCH = 10_000;

export async function purgeImports(tx: Tx): Promise<Record<string, number>> {
  const before = sql`now() - make_interval(days => ${config().AUDIT_RETENTION_DAYS})`;
  const runs = tx.select({ id: importRuns.id }).from(importRuns).where(lt(importRuns.startedAt, before)).orderBy(importRuns.startedAt).limit(PURGE_BATCH);
  const checks = tx.select({ id: importChecks.id }).from(importChecks).where(lt(importChecks.at, before)).orderBy(importChecks.at).limit(PURGE_BATCH);
  return {
    import_checks: (await tx.delete(importChecks).where(inArray(importChecks.id, checks)).returning({ one: sql`1` })).length,
    import_runs: (await tx.delete(importRuns).where(inArray(importRuns.id, runs)).returning({ one: sql`1` })).length,
  };
}
