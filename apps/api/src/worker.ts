// The worker process (spec §6, DEC-035): same image as the API, `bun src/worker.ts`. Runs the job handlers and the
// cron on pg-boss; its only port is the probe (GET /healthz on API_HOST:WORKER_HEALTH_PORT).
import { loadWorkerConfig } from "./kernel/config";
import { closeJobs, type JobHandler, type QueueName, startWorker, workerAlive } from "./kernel/jobs";
import { log } from "./kernel/log";
import { workerClient } from "./kernel/worker-db";

const { API_HOST, WORKER_HEALTH_PORT } = loadWorkerConfig(process.env);

/** The job handlers. None yet: Plans 2–4 register ingest, recon and SLA handlers here. */
const HANDLERS: Partial<Record<QueueName, JobHandler>> = {};

const stopWorker = await startWorker(HANDLERS);
// 200 while the queue loops are alive (fetched within 60 s or holding a job), else 503; anything else 404.
const server = Bun.serve({
  hostname: API_HOST,
  port: WORKER_HEALTH_PORT,
  fetch: (r) => new Response(null, { status: r.method === "GET" && new URL(r.url).pathname === "/healthz" ? (workerAlive() ? 200 : 503) : 404 }),
});
log.info({ url: server.url.href }, "worker running");

let stopping = false;
/** Take no new job, let the running ones end (25 s at most), close both pools, exit 0. */
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info({ signal }, "shutting down");
  await stopWorker();
  await server.stop(true);
  await closeJobs();
  await workerClient.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
