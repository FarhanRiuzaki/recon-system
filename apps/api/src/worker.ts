// The worker process (spec §6, DEC-035): same image as the API, `bun src/worker.ts`. Runs the job handlers and the
// cron on pg-boss; its only port is the probe (GET /healthz on API_HOST:WORKER_HEALTH_PORT).
import { loadWorkerConfig } from "./kernel/config";
import { closeJobs, enqueue, QUEUES, scheduleEvery, startWorker, unschedule, workerAlive } from "./kernel/jobs";
import { log } from "./kernel/log";
import { workerClient, workerDb } from "./kernel/worker-db";
import { engineHandlers } from "./modules/engine";
import { ingestHandlers } from "./modules/ingest";
import { integrationsHandlers } from "./modules/integrations";

const { API_HOST, WORKER_HEALTH_PORT } = loadWorkerConfig(process.env);

/** The job handlers, on the worker's pool (DEC-036): ingest (Plan 2), recon runs and simulations (Plan 3), approval actions (stage 4). */
const HANDLERS = { ...ingestHandlers(workerDb), ...engineHandlers(workerDb), ...integrationsHandlers(workerDb) };

const stopWorker = await startWorker(HANDLERS);
// Partitions daily at 00:10 Asia/Jakarta, and once now: a fresh install has none, and ingest makes one only as a fallback.
await scheduleEvery(QUEUES.maintenancePartitions, "daily", "10 0 * * *", {});
await enqueue(QUEUES.maintenancePartitions, {}, { key: "start" });
// The recon schedule's minute (engine schedule.ts dispatch): starts each due tick or daily run, from state, so a worker
// that was down catches up on its first minute.
await scheduleEvery(QUEUES.reconSchedule, "schedule", "* * * * *", {});
await unschedule(QUEUES.reconTick, "schedule"); // its first home (wt/task6 before review): a tick slot each minute
// approval actions left sending by a worker that died after the call went out become timeout, never sent again (O4)
await scheduleEvery(QUEUES.integrationsAction, "sweep", "* * * * *", { sweep: true });
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
