// Run by jobs.test.ts as `bun test/helpers/dying-worker.ts`: a worker whose recon.heavy handler commits the job's
// effect with its done marker, prints "committed", then hangs, so the test can SIGKILL it before pg-boss completes the
// job.
import { QUEUES, startWorker } from "../../src/kernel/jobs";
import { workerDb } from "../../src/kernel/worker-db";
import { applyOnce } from "./jobs";

await startWorker({
  [QUEUES.reconHeavy]: async (job) => {
    await applyOnce(workerDb, (job.data as { key: string }).key);
    console.log("committed");
    await new Promise(() => {});
  },
}, { pollingSeconds: 0.5 });
console.log("ready");
