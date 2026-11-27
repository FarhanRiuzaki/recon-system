// /v1/imports/feeds*: guard, check order, paging, uniqueness, the frozen history source, activity entries.
import { beforeEach, describe, expect, it } from "bun:test";
import type { Page } from "@starterkit/shared/contracts/common";
import type { ImportFeedDto, ImportFeedRowDto, ImportFeedSpec } from "@starterkit/shared/contracts/imports";
import { asc, eq } from "drizzle-orm";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { historyRow, resetStaging } from "../../../../../test/helpers/staging";
import { db } from "../../../../kernel/db";
import { activity } from "../../../audit";
import { importFeeds, importRuns } from "../../schema";

const code = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;
const acts = () => db.select({ action: activity.action, targetType: activity.targetType, targetLabel: activity.targetLabel, before: activity.before, after: activity.after })
  .from(activity).orderBy(asc(activity.at), asc(activity.id));

const spec = (historySource = "KAI_TLHIST", more: Partial<ImportFeedSpec> = {}): ImportFeedSpec => ({
  kind: "db_host", historySource, batchPrefix: "HISTORY_TLHIST", startDate: "2026-10-31", due: { time: "06:00", graceMinutes: 30 }, ...more,
});

let sa: string;
beforeEach(async () => {
  await resetData();
  await resetStaging();
  await db.delete(activity);
  await db.delete(importFeeds); // the demo seed's; each case makes its own
  sa = await signIn("superadmin");
});

const get = (path: string, token?: string) => call("GET", path, { token });
const create = (body: unknown, token = sa) => call("POST", "/v1/imports/feeds", { token, body });
const patch = (id: string, body: unknown, token = sa) => call("PATCH", `/v1/imports/feeds/${id}`, { token, body });
const del = (id: string, token = sa) => call("DELETE", `/v1/imports/feeds/${id}`, { token });
const make = async (name: string, s = spec()) => {
  const r = await create({ name, spec: s });
  expect(r.status).toBe(201);
  return (await r.json()) as ImportFeedDto;
};

describe("guard and check order", () => {
  it("needs a session and import.view; Viewer doesn't have it, Admin does", async () => {
    expect((await get("/v1/imports/feeds")).status).toBe(401);
    expect((await get("/v1/imports/feeds", await signIn("viewer"))).status).toBe(403);
    expect((await get("/v1/imports/feeds", await signIn("admin"))).status).toBe(200);
  });

  it.each([["pageSize=10"], ["page=1001"], ["sort=historySource"]])("rejects %s with 400 before the guard", async (qs) => {
    expect((await get(`/v1/imports/feeds?${qs}`)).status).toBe(400);
  });

  it("a body's 400 comes after the guard and before the 404", async () => {
    const viewer = await signIn("viewer");
    expect((await create({ name: "" }, viewer)).status).toBe(403);
    expect((await create({ name: "KAI", spec: spec("kai") })).status).toBe(400);
    expect((await create({ name: "KAI", spec: { ...spec(), due: { time: "6:00", graceMinutes: 30 } } })).status).toBe(400);
    expect((await create({ name: "KAI", spec: { ...spec(), extra: 1 } })).status).toBe(400);
    expect((await patch(Bun.randomUUIDv7(), { name: "" })).status).toBe(400);
    expect((await patch(Bun.randomUUIDv7(), { name: "X" })).status).toBe(404);
    expect((await patch("not-a-uuid", { name: "X" })).status).toBe(404);
  });

  it("a missing permission is 403 before anything changes", async () => {
    const f = await make("KAI host");
    const viewer = await signIn("viewer");
    expect((await create({ name: "Garuda host", spec: spec("GARUDA_TLHIST") }, viewer)).status).toBe(403);
    expect((await patch(f.id, { name: "Other" }, viewer)).status).toBe(403);
    expect((await del(f.id, viewer)).status).toBe(403);
    expect(await db.$count(importFeeds)).toBe(1);
  });
});

describe("feeds", () => {
  it("a feed entered for Monitoring only: scheduler off, table missing, and what it still lacks", async () => {
    const f = await make("KAI host");
    expect(f).toMatchObject({ name: "KAI host", kind: "db_host", spec: spec(), schedulerOn: false, tableState: "missing" });
    expect(f.missing[0]).toBe("Set the host connection.");
    expect(await (await get(`/v1/imports/feeds/${f.id}`, sa)).json()).toEqual(f);
    expect(await acts()).toEqual([{ action: "import.feed_create", targetType: "import_feed", targetLabel: "KAI host", before: null, after: { name: "KAI host", spec: spec() } }]);
  });

  it("lists by name, searches by name, pages", async () => {
    await make("Garuda host", spec("GARUDA_TLHIST"));
    await make("KAI host", spec("KAI_TLHIST", { schedule: { times: ["06:30", "08:30"], maxMinutes: 30 } }));
    await make("Indovision host", spec("INDOVISION_TLHIST"));
    const page = (await (await get("/v1/imports/feeds", sa)).json()) as Page<ImportFeedRowDto>;
    expect(page.items.map((x) => x.name)).toEqual(["Garuda host", "Indovision host", "KAI host"]);
    expect(page.items[2]).toMatchObject({ historySource: "KAI_TLHIST", table: null, schedulerOn: false, runTimes: ["06:30", "08:30"], complete: false });
    expect(((await (await get("/v1/imports/feeds?q=kai", sa)).json()) as Page<ImportFeedRowDto>).items.map((x) => x.name)).toEqual(["KAI host"]);
    expect(((await (await get("/v1/imports/feeds?sort=-name", sa)).json()) as Page<ImportFeedRowDto>).items[0]!.name).toBe("KAI host");
  });

  it("a name (any case) and a history source each belong to one feed", async () => {
    await make("KAI host");
    const sameName = await create({ name: "kai HOST", spec: spec("OTHER_TLHIST") });
    expect([sameName.status, await code(sameName)]).toEqual([409, "duplicate"]);
    const sameSource = await create({ name: "KAI again", spec: spec() });
    expect(sameSource.status).toBe(409);
    expect(((await sameSource.json()) as { error: { message: string } }).error.message).toContain("history source");
  });

  it("PATCH changes the fields sent, logs only those, and nothing changed writes no entry", async () => {
    const f = await make("KAI host");
    await db.delete(activity);
    expect((await patch(f.id, { name: "KAI host" })).status).toBe(200);
    expect(await acts()).toEqual([]);
    const later = spec("KAI_TLHIST", { due: { time: "07:00", graceMinutes: 15 } });
    const r = await patch(f.id, { spec: later });
    expect(((await r.json()) as ImportFeedDto).spec.due).toEqual({ time: "07:00", graceMinutes: 15 });
    expect(await acts()).toEqual([{ action: "import.feed_update", targetType: "import_feed", targetLabel: "KAI host", before: { spec: spec() }, after: { spec: later } }]);
  });

  it("the history source and batch prefix are frozen once staging history has a batch of that source", async () => {
    const f = await make("KAI host");
    expect((await patch(f.id, { spec: spec("KAI2_TLHIST") })).status).toBe(200); // no history yet: a typo can be fixed
    await historyRow({ source: "KAI2_TLHIST", date: "2026-11-03", status: "IMPORTED" });
    for (const next of [spec("KAI3_TLHIST"), { ...spec("KAI2_TLHIST"), batchPrefix: "TLHIST" }]) {
      const r = await patch(f.id, { spec: next });
      expect([r.status, await code(r)]).toEqual([409, "invalid_state"]);
    }
    expect((await patch(f.id, { spec: spec("KAI2_TLHIST", { due: { time: "07:00", graceMinutes: 0 } }) })).status).toBe(200);
  });

  it("DELETE removes the feed and its logs, keeps staging, and is refused while the scheduler is on", async () => {
    const f = await make("KAI host");
    await db.insert(importRuns).values({ id: Bun.randomUUIDv7(), feedId: f.id, trigger: "manual", status: "done" });
    await historyRow({ source: "KAI_TLHIST", date: "2026-11-03", status: "IMPORTED" });
    await db.update(importFeeds).set({ schedulerOn: true }).where(eq(importFeeds.id, f.id));
    const on = await del(f.id);
    expect([on.status, await code(on)]).toEqual([409, "invalid_state"]);
    await db.update(importFeeds).set({ schedulerOn: false }).where(eq(importFeeds.id, f.id));
    expect((await del(f.id)).status).toBe(200);
    expect([await db.$count(importFeeds), await db.$count(importRuns)]).toEqual([0, 0]);
    expect((await get(`/v1/imports/feeds/${f.id}`, sa)).status).toBe(404);
    expect((await acts()).at(-1)).toMatchObject({ action: "import.feed_delete", before: { name: "KAI host", spec: spec() }, after: null });
  });
});
