// Making report files: after a run (one per template and run, whatever the retries), on request (≤ 92 days), the next
// file version for the same dates, Final from the day's sign-off, the PDF row limit, a half-written file never served,
// retention, and the Test's sample (always masked, never listed).
import { columnFor } from "@starterkit/shared/report-spec";
import { breakDetail } from "../designs";
import { beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ReportFileDto, ReportSpec, ReportTemplateDto, ReportVersionDto } from "@starterkit/shared/contracts/reports";
import type { SpaceRole } from "@starterkit/shared/spaces";
import { and, eq } from "drizzle-orm";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { db } from "../../../../kernel/db";
import { boss, QUEUES } from "../../../../kernel/jobs";
import { ensureMonthPartitions } from "../../../../kernel/partitions";
import { reconDays, reconItems, reconRuns, runRecon } from "../../../engine";
import { D, D1, makeSource, plainSource, put, recon, spec as reconSpec } from "../fixtures";
import { records } from "../../../ingest";
import { spaceMembers, spaces } from "../../../spaces";
import { users } from "../../../users";
import { purgeReports, queueAfterRun, reportFiles, reportsHandlers } from "../../index";
import { makeFile } from "../../make";
import { loadWorkerConfig } from "../../../../kernel/config";

const ROOT = process.env.INBOX_ROOTS!.split(",")[0]!;
let A: string, code: string, CFG: string, VER: string, mk: string, op: string, T: ReportTemplateDto, V: ReportVersionDto;
const base = () => `/v1/spaces/${A}/reports`;
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const handle = () => reportsHandlers(db)[QUEUES.reportsMake]!;
async function drain() {
  const b = await boss();
  for (;;) {
    const jobs = await b.fetch(QUEUES.reportsMake, { batchSize: 10 });
    if (!jobs.length) return;
    for (const j of jobs) { await handle()({ id: j.id, data: j.data }); await b.complete(QUEUES.reportsMake, j.id); }
  }
}
const files = async () => (await db.select().from(reportFiles).where(eq(reportFiles.spaceId, A))).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

beforeEach(async () => {
  await resetData();
  await (await boss()).deleteAllJobs();
  await db.delete(spaces);
  A = Bun.randomUUIDv7(); code = `r${A.slice(-10)}`;
  await db.insert(spaces).values({ id: A, code, name: "Treasury" });
  const grant = async (u: string, role: SpaceRole) => { const [x] = await db.select({ id: users.id }).from(users).where(eq(users.username, u)); await db.insert(spaceMembers).values({ spaceId: A, userId: x!.id, role }); };
  await grant("admin", "config_maker"); await grant("google", "operator");
  mk = await signIn("admin"); op = await signIn("google");
  await db.transaction(async (tx) => {
    await ensureMonthPartitions(tx, records, new Date(`${D}T00:00:00Z`), 1);
    await ensureMonthPartitions(tx, reconItems, new Date(`${D}T00:00:00Z`), 1);
  });
  const [sa, sb] = [await makeSource(A, plainSource()), await makeSource(A, plainSource())];
  ({ configId: CFG, versionId: VER } = await recon(A, reconSpec(sa.sourceId, sb.sourceId, [])));
  const recs = await put(sa, Array.from({ length: 12 }, (_, i) => ({ ref: `R${i}`, amount: 100n, date: i % 2 ? D1 : D })));
  await db.insert(reconItems).values(recs.map((recordId, i) => ({ id: Bun.randomUUIDv7(), spaceId: A, configId: CFG, recordId, side: "a", status: "break", businessDate: i % 2 ? D1 : D, breakReason: "No counterpart" })));
  T = await json<ReportTemplateDto>(call("POST", `${base()}/templates`, { token: mk, body: { configId: CFG, name: "Break detail" } }));
  V = (await json<{ items: ReportVersionDto[] }>(call("GET", `${base()}/templates/${T.id}/versions`, { token: mk }))).items[0]!;
  V = await json<ReportVersionDto>(call("PATCH", `${base()}/templates/${T.id}/versions/${V.id}`, { token: mk, body: { spec: breakDetail() } }));
});

async function activate(spec: Partial<ReportSpec> = {}) {
  await call("PATCH", `${base()}/templates/${T.id}/versions/${V.id}`, { token: mk, body: { spec: { ...V.spec, when: { afterRun: true, onRequest: true }, output: { ...V.spec.output, format: "csv" }, ...spec } } });
  return json<ReportVersionDto>(call("POST", `${base()}/templates/${T.id}/versions/${V.id}/submit`, { token: mk }));
}
const run = async () => { const id = Bun.randomUUIDv7(); await db.insert(reconRuns).values({ id, spaceId: A, configId: CFG, configVersionId: VER, mode: "manual", dateFrom: D, dateTo: D1, status: "succeeded" }); return id; };

describe("report files", () => {
  it("after a run: one file per template and run, retried or not; ready with its rows, Final only for signed-off dates", async () => {
    await activate();
    const r = await run();
    await db.insert(reconDays).values({ spaceId: A, configId: CFG, businessDate: D, status: "closed", closedAt: new Date(), signedAt: new Date(), signedBy: Bun.randomUUIDv7() });
    await queueAfterRun(db, A, CFG, r, D, D1);
    await queueAfterRun(db, A, CFG, r, D, D1);
    await drain();
    const [f, ...more] = await files();
    expect(more).toEqual([]);
    expect([f!.status, f!.rows, f!.progress, f!.final, f!.runId]).toEqual(["ready", 12, 100, false, r]);
    expect(f!.dates).toEqual([{ date: D, final: true }, { date: D1, final: false }]);
    expect(existsSync(path.join(ROOT, code, ".reports", `${f!.id}.csv`))).toBe(true);
    // the job delivered again changes nothing
    await handle()({ id: "again", data: { spaceId: A, fileId: f!.id } });
    expect((await files()).length).toBe(1);
  }, 30_000);

  it("a real run queues its file; a simulation doesn't", async () => {
    await activate();
    await runRecon(db, { spaceId: A, configId: CFG, versionId: VER, mode: "manual", from: D, to: D1 });
    await runRecon(db, { spaceId: A, configId: CFG, versionId: VER, mode: "simulation", from: D, to: D1 });
    expect((await files()).map((f) => [f.status, f.fromDate, f.toDate, !!f.runId])).toEqual([["queued", D, D1, true]]);
  }, 30_000);

  it("on request: 92 days at most; the same dates again are the next file version; an operator may ask", async () => {
    await activate();
    const long = await call("POST", `${base()}/files`, { token: op, body: { templateId: T.id, from: "2026-08-01", to: "2026-11-01" } });
    expect([long.status, ((await long.json()) as { error: { message: string } }).error.message]).toEqual([400, "A report covers at most 92 days. Pick a shorter range."]);
    const a = await json<ReportFileDto>(call("POST", `${base()}/files`, { token: op, body: { templateId: T.id, from: D, to: D1 } }));
    const b = await json<ReportFileDto>(call("POST", `${base()}/files`, { token: op, body: { templateId: T.id, from: D, to: D1 } }));
    expect([a.status, a.fileVersion, b.fileVersion, a.madeBy.kind]).toEqual(["queued", 1, 2, "user"]);
    await drain();
    expect((await files()).map((f) => f.status)).toEqual(["ready", "ready"]);
  }, 30_000);

  it("a PDF of transactions over 5,000 rows fails with what to do", async () => {
    await activate({ output: { ...V.spec.output, format: "pdf" } });
    const [sa] = [await makeSource(A, plainSource())];
    // in batches: one insert of 5,001 rows passes PostgreSQL's 65,535 parameters
    for (const part of [2500, 2501]) {
      const recs = await put(sa!, Array.from({ length: part }, (_, i) => ({ ref: `X${part}-${i}`, amount: 1n, date: D })));
      await db.insert(reconItems).values(recs.map((recordId) => ({ id: Bun.randomUUIDv7(), spaceId: A, configId: CFG, recordId, side: "a", status: "break", businessDate: D })));
    }
    await call("POST", `${base()}/files`, { token: mk, body: { templateId: T.id, from: D, to: D } });
    await drain();
    const [f] = await files();
    expect([f!.status, f!.error]).toEqual(["failed", "A PDF holds at most 5,000 rows. Use CSV or Excel for more."]);
  }, 30_000);

  it("a file that failed halfway is never served; its part is swept; past retention a file is removed", async () => {
    await activate();
    const r = await run();
    await queueAfterRun(db, A, CFG, r, D, D1);
    await drain();
    const [f] = await files();
    const dir = path.join(ROOT, code, ".reports");
    mkdirSync(dir, { recursive: true });
    const part = path.join(dir, `.${Bun.randomUUIDv7()}.part`);
    writeFileSync(part, "half");
    const old = new Date(Date.now() - 2 * 3600_000);
    utimesSync(part, old, old);
    await db.update(reportFiles).set({ createdAt: new Date(Date.now() - 401 * 86400_000) }).where(eq(reportFiles.id, f!.id));
    await purgeReports(db);
    expect(readdirSync(dir).filter((n) => n.endsWith(".part"))).toEqual([]);
    const [gone] = await db.select().from(reportFiles).where(and(eq(reportFiles.spaceId, A), eq(reportFiles.id, f!.id)));
    expect([gone!.status, existsSync(path.join(dir, `${f!.id}.csv`))]).toEqual(["removed", false]);
  }, 30_000);

  it("the Test makes a masked sample file that is never listed", async () => {
    const t = await json<{ sampleId: string }>(call("POST", `${base()}/templates/${T.id}/versions/${V.id}/test`, { token: mk, body: { from: D, to: D } }));
    expect(t.sampleId).toBeString();
    await drain();
    const list = await json<{ items: unknown[] }>(call("GET", `${base()}/files`, { token: mk }));
    expect(list.items).toEqual([]);
    const [s] = await files();
    expect([s!.status, s!.masking, s!.sample]).toEqual(["ready", "masked", true]);
  });

  it("a file another worker is making now is left to it; one abandoned for hours is failed by the janitor and can be made again", async () => {
    await activate();
    const r = await run();
    await queueAfterRun(db, A, CFG, r, D, D1);
    const [f] = await files();
    await db.update(reportFiles).set({ status: "making", updatedAt: new Date() }).where(eq(reportFiles.id, f!.id));
    await makeFile(db, A, f!.id);
    expect((await files())[0]!.status).toBe("making");
    await db.update(reportFiles).set({ updatedAt: new Date(Date.now() - 5 * 3600_000) }).where(eq(reportFiles.id, f!.id));
    await purgeReports(db);
    expect((await files())[0]!.status).toBe("failed");
  }, 30_000);

  it("a grouped PDF holds at most 5,000 rows too", async () => {
    await activate({ groups: ["recon:reason"], totals: { on: true, perGroup: true, columns: {} }, output: { ...V.spec.output, format: "pdf" } });
    const [sa] = [await makeSource(A, plainSource())];
    for (const part of [2500, 2501]) {
      const recs = await put(sa!, Array.from({ length: part }, (_, i) => ({ ref: `G${part}-${i}`, amount: 1n, date: D })));
      await db.insert(reconItems).values(recs.map((recordId) => ({ id: Bun.randomUUIDv7(), spaceId: A, configId: CFG, recordId, side: "a", status: "break", businessDate: D })));
    }
    await call("POST", `${base()}/files`, { token: mk, body: { templateId: T.id, from: D, to: D } });
    await drain();
    expect((await files()).map((f) => f.error)).toEqual(["A PDF holds at most 5,000 rows. Use CSV or Excel for more."]);
  }, 60_000);

  it("an unexpected failure marks the file failed and is thrown, so the queue tries it again", async () => {
    await activate({ dataset: "recap", rows: { filters: [] }, columns: [columnFor("c1", "recap:date", "Date")], output: { ...V.spec.output, format: "pdf" } });
    const f = await json<ReportFileDto>(call("POST", `${base()}/files`, { token: mk, body: { templateId: T.id, from: D, to: D } }));
    const e = await makeFile(db, A, f.id, { ...loadWorkerConfig(process.env), REPORT_CHROMIUM_PATH: "/nowhere/chromium" }).catch((x) => x);
    expect(e).toBeInstanceOf(Error);
    expect((await files())[0]!.status).toBe("failed");
  }, 30_000);

  it("a run whose report files weren't queued (the hook failed) gets them from the janitor", async () => {
    await activate();
    const r = await run();
    await db.update(reconRuns).set({ finishedAt: new Date() }).where(eq(reconRuns.id, r));
    await purgeReports(db);
    expect((await files()).map((f) => f.runId)).toEqual([r]);
  }, 30_000);
});
