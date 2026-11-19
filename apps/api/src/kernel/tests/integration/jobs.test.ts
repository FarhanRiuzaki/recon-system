// The job kernel on pg-boss (spec §9, spike S2): merged ticks per key, the per-queue cap, recovery after a worker dies,
// the Asia/Jakarta cron, a graceful stop and the app role's rights on the pgboss schema.
import { afterAll, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { SQL } from "bun";
import { count, eq } from "drizzle-orm";
import path from "node:path";
import { fromBunSql, PgBoss } from "pg-boss";
import { migrateJobs } from "../../../db/migrate";
import { asAppRole } from "../../../../test/helpers/app-role";
import { applyOnce, dropProbe, effects, resetProbe } from "../../../../test/helpers/jobs";
import { db } from "../../db";
import { boss, closeJobs, enqueue, ensureQueues, QUEUE_OPTIONS, QUEUES, scheduleEvery, startWorker, unschedule, workerAlive } from "../../jobs";
import { log } from "../../log";
import { workerDb } from "../../worker-db";

const ROOT = path.join(import.meta.dir, "../../../..");
const FAST = { pollingSeconds: 0.5, superviseSeconds: 1 };

/** Polls `ok` every 50 ms until it holds, or throws after `ms`. */
async function until(ok: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (await ok()) return;
  throw new Error("condition not met in time");
}

/** A promise with its resolve, for a handler the test releases. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((r) => (open = r));
  return { open, opened };
}

const stateOf = async (queue: string, id: string) => (await (await boss()).findJobs(queue, { id }))[0];

beforeAll(async () => {
  await resetProbe(db);
});
afterAll(async () => {
  await dropProbe(db);
});
beforeEach(async () => {
  await (await boss()).deleteAllJobs();
});

describe("job kernel", () => {
  it("two enqueues with the same key while the first is queued: the second returns null (merged)", async () => {
    const first = await enqueue(QUEUES.reconTick, { n: 1 }, { key: "cfg-a" });
    expect(first).toBeString();
    expect(await enqueue(QUEUES.reconTick, { n: 2 }, { key: "cfg-a" })).toBeNull();
    expect(await enqueue(QUEUES.reconTick, { n: 3 }, { key: "cfg-b" })).toBeString();
  });

  it("a tick enqueued while the same key is active runs once after it, not twice", async () => {
    const first = gate();
    const started = gate();
    const runs: { n: number; at: number; end?: number }[] = [];
    const stop = await startWorker({
      [QUEUES.reconTick]: async (job) => {
        const run: { n: number; at: number; end?: number } = { n: (job.data as { n: number }).n, at: Date.now() };
        runs.push(run);
        if (run.n === 1) {
          started.open();
          await first.opened;
        }
        run.end = Date.now();
      },
    }, FAST);
    try {
      await enqueue(QUEUES.reconTick, { n: 1 }, { key: "cfg-a" });
      await started.opened;
      expect(await enqueue(QUEUES.reconTick, { n: 2 }, { key: "cfg-a" })).toBeString(); // queued behind the active one
      expect(await enqueue(QUEUES.reconTick, { n: 3 }, { key: "cfg-a" })).toBeNull(); // merged into it
      await Bun.sleep(1500); // three polls of a worker with 4 free slots: the queued tick still waits
      expect(runs.map((r) => r.n)).toEqual([1]);
      first.open();
      await until(() => runs.length === 2 && runs[1]!.end !== undefined);
      await Bun.sleep(1000);
      expect(runs.map((r) => r.n)).toEqual([1, 2]);
      expect(runs[1]!.at).toBeGreaterThanOrEqual(runs[0]!.end!);
    } finally {
      first.open();
      await stop();
    }
  }, 20_000);

  it("per-queue cap: 10 recon.heavy jobs never run more than 1 at a time in one worker", async () => {
    let running = 0;
    let most = 0;
    let done = 0;
    const stop = await startWorker({
      [QUEUES.reconHeavy]: async () => {
        most = Math.max(most, ++running);
        await Bun.sleep(50);
        running--;
        done++;
      },
    }, FAST);
    try {
      for (let i = 0; i < 10; i++) expect(await enqueue(QUEUES.reconHeavy, { i }, { key: `cfg-${i}` })).toBeString();
      await until(() => done === 10, 15_000);
      expect(most).toBe(1);
    } finally {
      await stop();
    }
  }, 20_000);

  it("a job whose worker dies is failed by its heartbeat, not the 900 s expiry, picked up again and its effect written once", async () => {
    // Heartbeat 10 s (pg-boss's minimum) for the test; production queues carry QUEUE_OPTIONS (30 s). A job keeps the
    // heartbeat its queue had when it was sent, so the dying worker resetting the queue to QUEUE_OPTIONS doesn't matter.
    await ensureQueues({ ...QUEUE_OPTIONS, [QUEUES.reconHeavy]: { heartbeatSeconds: 10 } });
    try {
      const key = `die-${Bun.randomUUIDv7()}`;
      const id = await enqueue(QUEUES.reconHeavy, { key }, { key });
      expect(id).toBeString();
      expect(await stateOf(QUEUES.reconHeavy, id!)).toMatchObject({ heartbeatSeconds: 10, expireInSeconds: 900 });
      const child = Bun.spawn(["bun", path.join(ROOT, "test/helpers/dying-worker.ts")], { cwd: ROOT, env: process.env, stdout: "pipe", stderr: "inherit" });
      let out = "";
      const reader = child.stdout.getReader();
      await until(async () => {
        const { value } = await reader.read();
        out += new TextDecoder().decode(value ?? new Uint8Array());
        return out.includes("committed");
      }, 15_000);
      child.kill("SIGKILL");
      await child.exited;
      const killedAt = Date.now();
      expect((await stateOf(QUEUES.reconHeavy, id!))?.state).toBe("active"); // the dead worker never completed it

      const stop = await startWorker({ [QUEUES.reconHeavy]: async (job) => applyOnce(workerDb, (job.data as { key: string }).key) }, FAST);
      try {
        await until(async () => (await stateOf(QUEUES.reconHeavy, id!))?.state === "completed", 30_000);
        expect(Date.now() - killedAt).toBeLessThan(30_000); // heartbeat 10 s + supervise 1 s, far under the expiry
        const job = await stateOf(QUEUES.reconHeavy, id!);
        expect(job!.retryCount).toBeGreaterThanOrEqual(1);
        const [row] = await db.select({ n: count() }).from(effects).where(eq(effects.key, key));
        expect(row!.n).toBe(1);
      } finally {
        await stop();
      }
    } finally {
      await ensureQueues();
    }
  }, 60_000);

  it("a live handler that runs past its heartbeat keeps the job (pg-boss refreshes it while the handler runs)", async () => {
    await ensureQueues({ ...QUEUE_OPTIONS, [QUEUES.reconHeavy]: { heartbeatSeconds: 10 } });
    let calls = 0;
    const stop = await startWorker({
      [QUEUES.reconHeavy]: async () => {
        calls++;
        await Bun.sleep(13_000); // longer than the heartbeat; the supervisor checks every second
      },
    }, FAST);
    try {
      const id = await enqueue(QUEUES.reconHeavy, {}, { key: "long" });
      await until(async () => (await stateOf(QUEUES.reconHeavy, id!))?.state === "completed", 25_000);
      expect((await stateOf(QUEUES.reconHeavy, id!))?.retryCount).toBe(0);
      expect(calls).toBe(1);
    } finally {
      await stop();
      await ensureQueues();
    }
  }, 40_000);

  it("a change of the queue options reaches a queue that already exists", async () => {
    const read = async () => (await (await boss()).getQueue(QUEUES.ingestPull))?.heartbeatSeconds;
    expect(await read()).toBe(QUEUE_OPTIONS[QUEUES.ingestPull].heartbeatSeconds!);
    await ensureQueues({ ...QUEUE_OPTIONS, [QUEUES.ingestPull]: { heartbeatSeconds: 45 } });
    try {
      expect(await read()).toBe(45);
    } finally {
      await ensureQueues();
    }
    expect(await read()).toBe(30);
  });

  it("scheduleEvery with '0 23 * * *' fires at 23:00 Asia/Jakarta, i.e. 16:00 UTC", async () => {
    await scheduleEvery(QUEUES.breaksSla, "sla-test", "0 23 * * *", { scope: "all" });
    try {
      const b = await boss();
      const s = await b.getSchedule(QUEUES.breaksSla, "sla-test");
      expect(s).toMatchObject({ cron: "0 23 * * *", timezone: "Asia/Jakarta", data: { scope: "all" } });
      // The evaluation the cron pass runs on the stored row (cron-parser in its time zone), from a fixed instant.
      expect(b.previewSchedule(s!.cron, { tz: s!.timezone, from: new Date("2026-11-19T00:00:00Z"), count: 2 }))
        .toEqual([new Date("2026-11-19T16:00:00Z"), new Date("2026-11-20T16:00:00Z")]);
    } finally {
      await unschedule(QUEUES.breaksSla, "sla-test");
    }
    expect(await (await boss()).getSchedule(QUEUES.breaksSla, "sla-test")).toBeNull();
  });

  it("stop() lets the running job finish and takes no new job", async () => {
    const release = gate();
    const started = gate();
    const seen: string[] = [];
    let finished = false;
    const stop = await startWorker({
      [QUEUES.reconHeavy]: async (job) => {
        seen.push(job.id);
        started.open();
        await release.opened;
        finished = true;
      },
    }, FAST);
    const a = await enqueue(QUEUES.reconHeavy, {}, { key: "cfg-a" });
    const b = await enqueue(QUEUES.reconHeavy, {}, { key: "cfg-b" });
    await started.opened;
    expect(workerAlive()).toBe(true);
    const stopped = stop();
    await Bun.sleep(300);
    expect(finished).toBe(false); // stop() is waiting on the running job
    release.open();
    await stopped;
    expect(finished).toBe(true);
    expect(seen).toHaveLength(1);
    const [first, second] = seen[0] === a ? [a, b] : [b, a];
    expect((await stateOf(QUEUES.reconHeavy, first!))?.state).toBe("completed");
    expect((await stateOf(QUEUES.reconHeavy, second!))?.state).toBe("created");
    expect(workerAlive()).toBe(false);
  }, 20_000);

  it("the app role (APP_DB_ROLE) can send and fetch jobs after migrate granted it the pgboss schema", async () => {
    await db.transaction(async (tx) => asAppRole(tx)); // creates recon_app_probe (NOLOGIN, DML only) and commits
    process.env.APP_DB_ROLE = "recon_app_probe";
    try {
      await migrateJobs();
    } finally {
      delete process.env.APP_DB_ROLE;
    }
    await boss(); // the queues exist
    const asApp = new SQL(process.env.DATABASE_URL!, { max: 2, connection: { role: "recon_app_probe" } });
    const app = new PgBoss({ db: fromBunSql(asApp), migrate: false, supervise: false, schedule: false });
    app.on("error", () => {});
    try {
      const [who] = await asApp`select current_user as u`;
      expect(who.u).toBe("recon_app_probe");
      await app.start();
      const id = await app.send(QUEUES.ingestFile, { sha256: "x" }, { singletonKey: "file-x" });
      expect(id).toBeString();
      const [job] = await app.fetch(QUEUES.ingestFile);
      expect(job?.id).toBe(id!);
      await app.complete(QUEUES.ingestFile, id!);
      // DML only: the schema itself stays the owner's.
      const err = await asApp`create table pgboss.not_mine (x int)`.catch((e: Error) => e);
      expect(String(err)).toContain("permission denied");
    } finally {
      await app.stop({ close: false, graceful: false });
      await asApp.close();
    }
  }, 20_000);

  it("startWorker's real options (supervise, schedule, reindex false) run a job end to end as the app role", async () => {
    await db.transaction(async (tx) => asAppRole(tx));
    process.env.APP_DB_ROLE = "recon_app_probe";
    try {
      await migrateJobs();
    } finally {
      delete process.env.APP_DB_ROLE;
    }
    // jobs.ts's own pool, reopened on a URL whose startup parameter `role` makes every connection the app role.
    const url = process.env.DATABASE_URL!;
    const asApp = new URL(url);
    asApp.searchParams.set("role", "recon_app_probe");
    await closeJobs();
    process.env.DATABASE_URL = asApp.href;
    const errors = spyOn(log, "error");
    let ran = 0;
    try {
      const stop = await startWorker({ [QUEUES.ingestFile]: async () => void ran++ }, FAST);
      try {
        const [who] = (await (await boss()).getDb().executeSql("select current_user as u")).rows as { u: string }[];
        expect(who!.u).toBe("recon_app_probe");
        const id = await enqueue(QUEUES.ingestFile, {}, { key: "noop" });
        await until(async () => (await stateOf(QUEUES.ingestFile, id!))?.state === "completed");
        await Bun.sleep(2500); // two supervise passes (1 s) and the cron's first pass
        expect(ran).toBe(1);
        expect(errors.mock.calls).toEqual([]);
      } finally {
        await stop();
      }
    } finally {
      errors.mockRestore();
      await closeJobs();
      process.env.DATABASE_URL = url;
    }
  }, 20_000);

  it("the worker process answers /healthz 200 while its loop runs and exits 0 on SIGTERM", async () => {
    const port = 4190 + Math.floor(Math.random() * 9);
    const child = Bun.spawn(["bun", "src/worker.ts"], { cwd: ROOT, env: { ...process.env, WORKER_HEALTH_PORT: String(port) }, stdout: "ignore", stderr: "inherit" });
    try {
      await until(async () => (await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null))?.status === 200, 15_000);
      expect((await fetch(`http://127.0.0.1:${port}/other`)).status).toBe(404);
      child.kill("SIGTERM");
      expect(await child.exited).toBe(0);
    } finally {
      child.kill("SIGKILL");
    }
  }, 30_000);
});
