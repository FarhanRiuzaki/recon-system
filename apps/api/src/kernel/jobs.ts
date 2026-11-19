// The job kernel (spec §9, DEC-035, spike S2 in docs/recon/spikes.md): pg-boss queues in PostgreSQL, no broker.
// pg-boss's schema is installed by db:migrate (migrateJobs, as the owner); here pg-boss runs with migrate: false, as the
// app role, over a Bun SQL pool of its own.
import { SQL } from "bun";
import { fromBunSql, PgBoss, type ConstructorOptions } from "pg-boss";
import { loadDbConfig } from "./config";
import { errorDetail } from "./errors";
import { log } from "./log";

/** The queues (spec §9 table). Each job carries a key (its config, source, file…): see `enqueue`. */
export const QUEUES = {
  ingestPull: "ingest.pull",
  ingestFile: "ingest.file",
  reconTick: "recon.tick",
  reconDaily: "recon.daily",
  reconHeavy: "recon.heavy",
  breaksSla: "breaks.sla",
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

/** Jobs of one queue a worker process runs at once, so EOD runs and reruns don't starve the 2-minute ticks. */
export const CONCURRENCY: Record<QueueName, number> = {
  "ingest.pull": 4, "ingest.file": 2, "recon.tick": 4, "recon.daily": 2, "recon.heavy": 1, "breaks.sla": 1,
};

/** The cron time zone of every schedule. */
export const JOB_TZ = "Asia/Jakarta";

/**
 * How long stop() waits for running jobs: 5 s under the pod's default terminationGracePeriodSeconds (30 s), so the jobs
 * still running are failed (and retried by another worker) before the kill instead of waiting out their expiry.
 */
const STOP_GRACE_MS = 25_000;

export type JobHandler = (job: { id: string; data: unknown }) => Promise<void>;

let pool: SQL | undefined;
/**
 * pg-boss's pool: DATABASE_URL, DB_POOL_MAX connections, the API pool's timeouts (its statements are short). Opened on
 * first use, so db:migrate can import QUEUES without a DATABASE_URL.
 */
function jobsPool(): SQL {
  if (pool) return pool;
  const { DATABASE_URL, DB_POOL_MAX } = loadDbConfig(process.env);
  return (pool = new SQL(DATABASE_URL, { max: DB_POOL_MAX, connection: { statement_timeout: 5000, idle_in_transaction_session_timeout: 10000 } }));
}

function newBoss(options: ConstructorOptions): PgBoss {
  const b = new PgBoss({ db: fromBunSql(jobsPool()), migrate: false, ...options });
  b.on("error", (err) => log.error({ err: errorDetail(err) }, "job queue error"));
  return b;
}

let producer: Promise<PgBoss> | undefined;
/**
 * The process's pg-boss for sending and reading jobs (no maintenance, no cron), started on first use. It creates the
 * queues that don't exist yet, all `stately` (per key at most one job queued and one active), with pg-boss's default
 * expiry (15 min), retries (2) and retention; a queue's policy is fixed once created.
 */
export function boss(): Promise<PgBoss> {
  producer ??= (async () => {
    const b = newBoss({ supervise: false, schedule: false });
    await b.start();
    for (const name of Object.values(QUEUES)) {
      await b.createQueue(name, { policy: "stately" });
    }
    return b;
  })().catch((err: unknown) => {
    producer = undefined;
    throw err;
  });
  return producer;
}

/**
 * Queues a job of `queue` under `key` (its config, source, file…), to start no sooner than `startAfter`. Null when a
 * job with that key is already queued: the two are merged (one queued and one active per key, never two of either).
 */
export async function enqueue(queue: QueueName, data: object, opts: { key: string; startAfter?: Date }): Promise<string | null> {
  return (await boss()).send(queue, data, { singletonKey: opts.key, startAfter: opts.startAfter });
}

/**
 * Sends `data` to `queue` under `key` on every `cron` occurrence, evaluated in Asia/Jakarta. Replaces the schedule of
 * the same queue and key. Occurrences missed while no worker ran come as one job for the latest of them (catch-up).
 */
export async function scheduleEvery(queue: QueueName, key: string, cron: string, data: object): Promise<void> {
  await (await boss()).schedule(queue, cron, data, { tz: JOB_TZ, key, singletonKey: key, missed: "once" });
}

export async function unschedule(queue: QueueName, key: string): Promise<void> {
  await (await boss()).unschedule(queue, key);
}

/** pg-boss intervals a test shortens; production keeps the defaults. */
export type WorkerTuning = { pollingSeconds?: number; superviseSeconds?: number };

const running = new Set<PgBoss>();

/**
 * Runs `handlers`, each queue at most CONCURRENCY[queue] jobs at once in this process, plus pg-boss's maintenance
 * (expiry of jobs whose worker died) and the cron. A handler that throws fails the job, which pg-boss retries. Returns
 * stop: it takes no new job, waits for the running ones (STOP_GRACE_MS at most) and fails what is still running.
 */
export async function startWorker(handlers: Partial<Record<QueueName, JobHandler>>, tuning: WorkerTuning = {}): Promise<() => Promise<void>> {
  await boss(); // the queues exist
  const { pollingSeconds = 2, superviseSeconds = 60 } = tuning;
  // reindex: false: REINDEX needs the owner, and the worker connects as the app role.
  const b = newBoss({ supervise: true, schedule: true, reindex: false, superviseIntervalSeconds: superviseSeconds, monitorIntervalSeconds: superviseSeconds });
  await b.start();
  for (const [queue, handle] of Object.entries(handlers) as [QueueName, JobHandler][]) {
    await b.work(queue, { localConcurrency: CONCURRENCY[queue], pollingIntervalSeconds: pollingSeconds }, async ([job]) => {
      if (job) await handle({ id: job.id, data: job.data });
    });
  }
  running.add(b);
  return async () => {
    running.delete(b);
    await b.stop({ graceful: true, timeout: STOP_GRACE_MS, close: false });
  };
}

/**
 * True while a worker runs and each of its queue loops has fetched within 60 s or holds a job (the worker's /healthz).
 * A worker with no handlers counts as alive while started.
 */
export function workerAlive(now = Date.now()): boolean {
  if (!running.size) return false;
  for (const b of running) {
    for (const w of b.getWipData()) if (w.count === 0 && now - (w.lastFetchedOn ?? w.createdOn) > 60_000) return false;
  }
  return true;
}

/** Stops the sending pg-boss and closes pg-boss's pool (after every stop() returned; the worker's shutdown). */
export async function closeJobs(): Promise<void> {
  const b = producer && (await producer.catch(() => undefined));
  producer = undefined;
  await b?.stop({ graceful: false, close: false });
  await pool?.close();
  pool = undefined;
}
