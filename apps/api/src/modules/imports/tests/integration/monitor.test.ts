// Monitoring over staging history written as import-host writes it: cells, scheduler states, the badge, a date opened,
// the history, run and check pages.
import { beforeEach, describe, expect, it } from "bun:test";
import type { Page } from "@starterkit/shared/contracts/common";
import type { ImportCheckDto, ImportDateDto, ImportHistoryDto, ImportMonitorDto, ImportRunDto } from "@starterkit/shared/contracts/imports";
import { eq } from "drizzle-orm";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { historyRow, resetStaging } from "../../../../../test/helpers/staging";
import { db } from "../../../../kernel/db";
import { users } from "../../../users";
import { issues, monitor } from "../../monitor";
import { jakartaAt } from "../../rules";
import { importChecks, importFeeds, importHeartbeat, importRuns } from "../../schema";
import { beat } from "../../worker";

const spec = (historySource: string, more: object = {}) => ({
  kind: "db_host", historySource, batchPrefix: "HISTORY_TLHIST", startDate: "2026-10-31", due: { time: "06:30", graceMinutes: 30 }, ...more,
});
// 2026-11-05 07:00 WIB: MIS date 2026-11-04 is due now (06:30 + 30 min)
const NOW = new Date("2026-11-05T00:00:00Z");

let sa: string;
let kai: string;
let garuda: string;
beforeEach(async () => {
  await resetData();
  await resetStaging();
  await db.delete(importFeeds);
  sa = await signIn("superadmin");
  kai = Bun.randomUUIDv7();
  garuda = Bun.randomUUIDv7();
  await db.insert(importFeeds).values([
    { id: kai, name: "KAI host", spec: spec("KAI_TLHIST", { schedule: { times: ["06:30", "08:30"], maxMinutes: 30 } }), schedulerOn: true, schedulerChangedAt: new Date("2026-11-01T00:00:00Z") },
    { id: garuda, name: "Garuda host", spec: spec("GARUDA_TLHIST", { startDate: "2026-11-03" }) },
  ]);
});

const cells = (m: ImportMonitorDto, id: string) => Object.fromEntries(m.feeds.find((f) => f.id === id)!.cells.map((c) => [c.date, c.state]));

describe("monitor", () => {
  it("cells from history as import-host wrote it: on time, late, failed, rerun, missing, not before the start date", async () => {
    await historyRow({ source: "KAI_TLHIST", date: "2026-11-01", status: "IMPORTED", rows: 1, createdAt: "2026-11-01T23:30:02Z" });
    await historyRow({ source: "KAI_TLHIST", date: "2026-11-02", status: "IMPORTED", rows: 2, createdAt: "2026-11-03T01:30:02Z" }); // 08:30 WIB: late
    await historyRow({ source: "KAI_TLHIST", date: "2026-11-03", status: "FAILED", error: "UNMAPPED 1 rows: TLBTCD 4625 mapping is not verified yet", createdAt: "2026-11-03T23:30:02Z" });
    await historyRow({ source: "GARUDA_TLHIST", date: "2026-11-03", status: "RERUN", createdAt: "2026-11-03T23:30:02Z" });
    const m = await monitor({}, NOW);
    expect(m.dates).toHaveLength(14);
    expect(m.dates.at(-1)).toBe("2026-11-04");
    expect(m.feeds.map((f) => f.name)).toEqual(["Garuda host", "KAI host"]);
    const k = cells(m, kai);
    expect(k).toMatchObject({ "2026-10-31": "missing", "2026-11-01": "imported", "2026-11-02": "late", "2026-11-03": "failed", "2026-11-04": "missing" });
    expect(k["2026-10-30"]).toBeUndefined(); // before the start date
    expect(cells(m, garuda)).toEqual({ "2026-11-03": "rerun", "2026-11-04": "missing" });
    expect(m.feeds.find((f) => f.id === kai)!.cells.find((c) => c.date === "2026-11-03")!.message).toContain("4625");
    expect(m.today).toMatchObject({ missing: 2, imported: 0 });
  });

  it("schedulers: off, missed, stuck, lock left (also import-host's), and the run that ran with nothing to do", async () => {
    const run = (scheduledFor: Date, more: object = {}) => ({ id: Bun.randomUUIDv7(), feedId: kai, trigger: "schedule", status: "done", scheduledFor, startedAt: scheduledFor, heartbeatAt: scheduledFor, finishedAt: scheduledFor, ...more });
    const sched = (m: ImportMonitorDto, id: string) => m.feeds.find((f) => f.id === id)!.scheduler;
    expect(sched(await monitor({}, NOW), garuda)).toMatchObject({ state: "off", nextRun: null });
    expect(sched(await monitor({}, NOW), kai)).toMatchObject({ state: "missed", message: "The 06:30 run didn't start." });
    await db.insert(importRuns).values([run(jakartaAt("2026-11-04", "08:30")), run(jakartaAt("2026-11-05", "06:30"))]);
    expect(sched(await monitor({}, NOW), kai)).toMatchObject({ state: "ok", nextRun: jakartaAt("2026-11-05", "08:30").toISOString() });
    expect(sched(await monitor({}, NOW), kai).lastRun).toMatchObject({ status: "done", scheduledFor: jakartaAt("2026-11-05", "06:30").toISOString(), by: null });
    await db.insert(importRuns).values(run(jakartaAt("2026-11-05", "06:30"), { status: "running", finishedAt: null, startedAt: new Date("2026-11-04T23:55:00Z"), heartbeatAt: new Date("2026-11-04T23:55:00Z") }));
    expect(sched(await monitor({}, NOW), kai).state).toBe("stuck");
    await historyRow({ source: "GARUDA_TLHIST", date: "2026-11-04", status: "PROCESSING", createdAt: "2026-11-04T22:00:00Z" });
    expect(sched(await monitor({}, NOW), garuda)).toMatchObject({ state: "lock_left", message: "The batch of 2026-11-04 is still held by a run that stopped." });
  });

  it("the worker's minute (imports.beat) writes one row, moved forward each time", async () => {
    await db.delete(importHeartbeat);
    await beat(db);
    const [first] = await db.select().from(importHeartbeat);
    await Bun.sleep(5);
    await beat(db);
    const rows = await db.select().from(importHeartbeat);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe("worker");
    expect(rows[0]!.at.getTime()).toBeGreaterThanOrEqual(first!.at.getTime());
  });

  it("the worker is alive while its minute is fresh", async () => {
    expect((await monitor({}, NOW)).workerAlive).toBe(false);
    await db.insert(importHeartbeat).values({ key: "worker", at: new Date(NOW.getTime() - 60_000) });
    expect((await monitor({}, NOW)).workerAlive).toBe(true);
    await db.update(importHeartbeat).set({ at: new Date(NOW.getTime() - 4 * 60_000) });
    expect((await monitor({}, NOW)).workerAlive).toBe(false);
  });

  it("the badge counts missing and failed cells, bad schedulers and a down worker while a scheduler is on", async () => {
    // KAI: 5 missing (31 Oct – 4 Nov) + missed; Garuda: 2 missing (3–4 Nov); worker down (KAI is on)
    expect(await issues(NOW)).toEqual({ count: 5 + 1 + 2 + 1 });
    await historyRow({ source: "GARUDA_TLHIST", date: "2026-11-03", status: "IMPORTED", createdAt: "2026-11-03T23:00:00Z" });
    await db.update(importFeeds).set({ schedulerOn: false }).where(eq(importFeeds.id, kai));
    expect(await issues(NOW)).toEqual({ count: 5 + 1 });
  });

  it("the route: import.view, staging dates, a feed's date opened, and a bad date is 404", async () => {
    expect((await call("GET", "/v1/imports/monitor")).status).toBe(401);
    expect((await call("GET", "/v1/imports/monitor", { token: await signIn("viewer") })).status).toBe(403);
    expect((await call("GET", "/v1/imports/monitor?to=2026-13-01", { token: sa })).status).toBe(400);
    const r = await call("GET", "/v1/imports/monitor?to=2026-11-04", { token: sa });
    expect(((await r.json()) as ImportMonitorDto).dates.at(-1)).toBe("2026-11-04");
    expect((await call("GET", "/v1/imports/issues", { token: await signIn("admin") })).status).toBe(200);

    await historyRow({ source: "KAI_TLHIST", date: "2026-11-03", status: "SUPERSEDED", error: "boom", createdAt: "2026-11-03T23:30:00Z" });
    await historyRow({ source: "KAI_TLHIST", date: "2026-11-03", status: "IMPORTED", rows: 3, createdAt: "2026-11-04T01:30:00Z" });
    const [me] = await db.select({ id: users.id }).from(users).where(eq(users.username, "superadmin"));
    await db.insert(importChecks).values([
      { id: Bun.randomUUIDv7(), feedId: kai, fileDate: "2026-11-03", at: new Date("2026-11-03T23:30:00Z"), trigger: "schedule", result: "not_ready" },
      { id: Bun.randomUUIDv7(), feedId: kai, fileDate: "2026-11-03", at: new Date("2026-11-04T01:30:00Z"), trigger: "manual", result: "imported", rows: 3, inserted: 3, userId: me!.id },
    ]);
    const d = (await (await call("GET", `/v1/imports/feeds/${kai}/dates/2026-11-03`, { token: sa })).json()) as ImportDateDto;
    expect(d.state).toBe("late");
    expect(d.versions.map((v) => v.status)).toEqual(["IMPORTED", "SUPERSEDED"]);
    expect(d.checks.map((c) => [c.result, c.by?.name ?? null])).toEqual([["imported", "Super Admin"], ["not_ready", null]]);
    for (const bad of ["2026-02-30", "03-11-2026", "x"]) expect((await call("GET", `/v1/imports/feeds/${kai}/dates/${bad}`, { token: sa })).status).toBe(404);
    expect((await call("GET", `/v1/imports/feeds/${Bun.randomUUIDv7()}/dates/2026-11-03`, { token: sa })).status).toBe(404);
  });
});

describe("history, runs and checks pages", () => {
  it("history: the feed's source only, newest first, filtered by date and status, paged", async () => {
    for (const d of ["2026-11-01", "2026-11-02", "2026-11-03"]) await historyRow({ source: "KAI_TLHIST", date: d, status: "IMPORTED", createdAt: `${d}T23:30:00Z` });
    await historyRow({ source: "GARUDA_TLHIST", date: "2026-11-03", status: "IMPORTED" });
    const page = async (qs: string) => (await (await call("GET", `/v1/imports/feeds/${kai}/history?${qs}`, { token: sa })).json()) as Page<ImportHistoryDto>;
    const all = await page("");
    expect([all.total, all.items.map((h) => h.fileDate)]).toEqual([3, ["2026-11-03", "2026-11-02", "2026-11-01"]]);
    expect(all.items[0]).toMatchObject({ fileName: "HISTORY_TLHIST:2026-11-03", status: "IMPORTED", fileHash: "0".repeat(64) });
    expect((await page("date=2026-11-02")).items.map((h) => h.fileDate)).toEqual(["2026-11-02"]);
    expect((await page("status=FAILED")).total).toBe(0);
    expect((await page("sort=fileDate")).items[0]!.fileDate).toBe("2026-11-01");
    expect((await call("GET", `/v1/imports/feeds/${kai}/history?status=DONE`, { token: sa })).status).toBe(400);
  });

  it("runs and checks: the feed's own, newest first, with who started a manual one", async () => {
    const [me] = await db.select({ id: users.id }).from(users).where(eq(users.username, "superadmin"));
    await db.insert(importRuns).values([
      { id: Bun.randomUUIDv7(), feedId: kai, trigger: "schedule", status: "done", startedAt: new Date("2026-11-04T23:30:00Z") },
      { id: Bun.randomUUIDv7(), feedId: kai, trigger: "manual", status: "failed", startedAt: new Date("2026-11-05T02:00:00Z"), userId: me!.id, message: "x" },
      { id: Bun.randomUUIDv7(), feedId: garuda, trigger: "schedule", status: "done" },
    ]);
    await db.insert(importChecks).values({ id: Bun.randomUUIDv7(), feedId: kai, fileDate: "2026-11-04", trigger: "schedule", result: "not_ready" });
    const runs = (await (await call("GET", `/v1/imports/feeds/${kai}/runs`, { token: sa })).json()) as Page<ImportRunDto>;
    expect(runs.items.map((r) => [r.trigger, r.status, r.by?.name ?? null])).toEqual([["manual", "failed", "Super Admin"], ["schedule", "done", null]]);
    expect(((await (await call("GET", `/v1/imports/feeds/${kai}/runs?status=done`, { token: sa })).json()) as Page<ImportRunDto>).total).toBe(1);
    const checks = (await (await call("GET", `/v1/imports/feeds/${kai}/checks?date=2026-11-04`, { token: sa })).json()) as Page<ImportCheckDto>;
    expect(checks.items.map((c) => c.result)).toEqual(["not_ready"]);
    expect((await call("GET", `/v1/imports/feeds/${Bun.randomUUIDv7()}/runs`, { token: sa })).status).toBe(404);
  });
});
