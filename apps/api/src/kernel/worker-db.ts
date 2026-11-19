import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { loadWorkerConfig } from "./config";

/**
 * The worker's own pool (DEC-036): WORKER_DB_POOL_MAX connections whose statements may run JOB_STATEMENT_TIMEOUT_MS
 * (a recon pass is longer than an API query; the API pool in kernel/db.ts stays at 5 s). Built when this file loads,
 * so only the worker process, which imports it, opens it. Idle-in-transaction stays 10 s as on the API pool.
 */
const { DATABASE_URL, WORKER_DB_POOL_MAX, JOB_STATEMENT_TIMEOUT_MS } = loadWorkerConfig(process.env);
export const workerClient = new SQL(DATABASE_URL, {
  max: WORKER_DB_POOL_MAX,
  connection: { statement_timeout: JOB_STATEMENT_TIMEOUT_MS, idle_in_transaction_session_timeout: 10000 },
});

/** Drizzle over the worker pool: job handlers query through it (a `Tx` like kernel/db.ts's `db`). */
export const workerDb = drizzle({ client: workerClient });
