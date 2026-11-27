// The staging database (DEC-066): recon_engine_import, where the stg_* tables and import_file_history live. Not ours:
// we never migrate it; import-host wrote it before us and both may write it during the switch. Two lazy pools, opened on
// first use only: the API's (5 s statements, like kernel/db.ts) and the worker's (JOB_STATEMENT_TIMEOUT_MS, a day's
// load). STAGING_DATABASE_URL unset = every caller gets the 409 the Import pages show as their empty state.
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { loadStagingConfig } from "../../../kernel/config";
import type { Tx } from "../../../kernel/db";
import { ApiError } from "../../../kernel/errors";

export const NOT_SET_UP = "The staging database isn't set up on this server.";

type Pool = { client: SQL; db: Tx };
let apiPool: Pool | undefined;
let jobPool: Pool | undefined;

const settings = () => loadStagingConfig(process.env);

/** STAGING_DATABASE_URL of `env`, or the 409 `invalid_state` every Import route that needs staging answers without one. */
export function stagingUrlOrThrow(env: Record<string, string | undefined>): string {
  const url = loadStagingConfig(env).STAGING_DATABASE_URL;
  if (!url) throw new ApiError("invalid_state", NOT_SET_UP);
  return url;
}

function open(statementTimeoutMs: number): Pool {
  const c = settings();
  const client = new SQL(stagingUrlOrThrow(process.env), {
    max: c.STAGING_POOL_MAX,
    connection: { statement_timeout: statementTimeoutMs, idle_in_transaction_session_timeout: 10000, application_name: "recon-imports" },
  });
  return { client, db: drizzle({ client }) };
}

/** Whether a staging database is configured. */
export const stagingSet = (): boolean => !!settings().STAGING_DATABASE_URL;

/** The API's staging handle (5 s statements); throws 409 `invalid_state` when staging isn't set up. */
export const staging = (): Tx => (apiPool ??= open(5000)).db;

/** The worker's staging handle (JOB_STATEMENT_TIMEOUT_MS statements), for a run's reads and writes. */
export const stagingForJobs = (): Tx => (jobPool ??= open(settings().JOB_STATEMENT_TIMEOUT_MS)).db;

/** Where things are in staging: the schema of every table, the history table, the role a created table is granted to. */
export function stagingNames(): { schema: string; history: string; readonlyRole: string | null } {
  const c = settings();
  return { schema: c.STAGING_SCHEMA, history: c.STAGING_HISTORY_TABLE, readonlyRole: c.STAGING_READONLY_ROLE ?? null };
}

/** Closes whichever pool was opened (shutdown). */
export async function closeStaging(): Promise<void> {
  const open = [apiPool, jobPool].filter((p): p is Pool => !!p);
  apiPool = jobPool = undefined;
  await Promise.all(open.map((p) => p.client.close()));
}
