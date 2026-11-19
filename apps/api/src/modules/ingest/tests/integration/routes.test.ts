// /v1/spaces/:spaceId/sources/:sourceId/{files,snapshots,quarantine,run}: roles, check order, paging, what a space
// a source is shared to may read, the run now (queued once, activity entry, day_closed, paused).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Page } from "@starterkit/shared/contracts/common";
import type { QuarantineRowDto, SourceDto, SourceFileDto, SourceRowDto, SourceSnapshotDto } from "@starterkit/shared/contracts/sources";
import type { SpaceRole } from "@starterkit/shared/spaces";
import { eq } from "drizzle-orm";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { db } from "../../../../kernel/db";
import { ensureMonthPartitions } from "../../../../kernel/partitions";
import { activity } from "../../../audit";
import { sourceShares, sources, sourceVersions } from "../../../sources";
import { spaceMembers, spaces } from "../../../spaces";
import { users } from "../../../users";
import { makeCalendar } from "../../map";
import { previousBusinessDay, todayIn } from "../../rules";
import { quarantineRows, records, sourceCursors, sourceFiles, sourceSnapshots } from "../../schema";
import { ingestHooks } from "../../service";
import { idDefault, ksei } from "../unit/fixtures";

const code = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const idOf = async (username: string) => (await db.select({ id: users.id }).from(users).where(eq(users.username, username)))[0]!.id;
const dayClosed = ingestHooks.dayClosed;

let A: string, B: string;
let t: Record<"adm" | "op" | "other", string>;
let FILE_SRC: string, SNAP_SRC: string;

const space = async (c: string) => {
  const id = Bun.randomUUIDv7();
  await db.insert(spaces).values({ id, code: c, name: c.toUpperCase() });
  return id;
};
const source = async (spaceId: string, kind: "file_inbox" | "db_snapshot") => {
  const id = Bun.randomUUIDv7();
  await db.insert(sources).values({ id, spaceId, code: `s-${id.slice(-12)}`, name: `Source ${kind}`, kind });
  const spec = kind === "file_inbox" ? ksei() : { ...ksei(), input: { kind: "db_snapshot", query: "select 1 where :business_date is not null", schedule: "0 6 * * *" } };
  await db.insert(sourceVersions).values({ id: Bun.randomUUIDv7(), spaceId, sourceId: id, version: 1, status: "published", spec, specHash: "h" });
  return id;
};
const path = (s: string, src: string, what: string) => `/v1/spaces/${s}/sources/${src}/${what}`;

beforeEach(async () => {
  await resetData();
  await db.delete(spaces);
  A = await space("treasury");
  B = await space("ctop");
  const grants: [string, string, SpaceRole][] = [[A, "admin", "source_admin"], [A, "apple", "viewer"], [B, "google", "viewer"]];
  for (const [spaceId, username, role] of grants) await db.insert(spaceMembers).values({ spaceId, userId: await idOf(username), role });
  t = { adm: await signIn("admin"), op: await signIn("apple"), other: await signIn("google") };
  FILE_SRC = await source(A, "file_inbox");
  SNAP_SRC = await source(A, "db_snapshot");
  await db.insert(sourceShares).values({ spaceId: A, sourceId: FILE_SRC, toSpaceId: B });
  const at = (m: number) => new Date(Date.UTC(2026, 10, 3, 0, m));
  await db.insert(sourceFiles).values([1, 2, 3].map((n) => ({
    id: Bun.randomUUIDv7(), spaceId: A, sourceId: FILE_SRC, name: `act2026110${n}.txt`, sha256: `sha${n}`, size: 10, modifiedAt: at(n),
    status: n === 3 ? "rejected" : "ingested", reason: n === 3 ? "Same file already ingested" : null, version: n === 3 ? null : 1, businessDate: `2026-11-0${n}`, receivedAt: at(n),
  })));
  await db.insert(quarantineRows).values({ id: Bun.randomUUIDv7(), spaceId: A, sourceId: FILE_SRC, origin: "file", originId: Bun.randomUUIDv7(), lineNo: 12, raw: "A1|B1", rawHash: "h1", reasons: { sid: "sid is required" }, businessDate: "2026-11-02" });
  await db.insert(sourceSnapshots).values([
    { id: Bun.randomUUIDv7(), spaceId: A, sourceId: SNAP_SRC, businessDate: "2026-11-02", status: "superseded", rows: 11, startedAt: at(1) },
    { id: Bun.randomUUIDv7(), spaceId: A, sourceId: SNAP_SRC, businessDate: "2026-11-02", status: "active", rows: 11, startedAt: at(2) },
  ]);
  await db.delete(activity);
});
afterEach(() => {
  ingestHooks.dayClosed = dayClosed;
});

describe("GET files, snapshots, quarantine", () => {
  it("any role reads them newest first, paged; another space's member is 403", async () => {
    const files = await json<Page<SourceFileDto>>(call("GET", `${path(A, FILE_SRC, "files")}?pageSize=15`, { token: t.op }));
    expect(files).toMatchObject({ total: 3, page: 1, pageSize: 15 });
    expect(files.items.map((f) => [f.name, f.status, f.reason])).toEqual([
      ["act20261103.txt", "rejected", "Same file already ingested"], ["act20261102.txt", "ingested", null], ["act20261101.txt", "ingested", null],
    ]);
    const snaps = await json<Page<SourceSnapshotDto>>(call("GET", path(A, SNAP_SRC, "snapshots"), { token: t.op }));
    expect(snaps.items.map((s) => s.status)).toEqual(["active", "superseded"]);
    const q = await json<Page<QuarantineRowDto>>(call("GET", path(A, FILE_SRC, "quarantine"), { token: t.op }));
    expect(q.items).toMatchObject([{ line: 12, raw: "A1|B1", reasons: { sid: "sid is required" }, origin: "file", businessDate: "2026-11-02" }]);
    expect((await call("GET", path(A, FILE_SRC, "files"), { token: t.other })).status).toBe(403);
  });

  it("the space a source is shared to reads its files but not its quarantine; an unshared one is 404", async () => {
    expect((await json<Page<SourceFileDto>>(call("GET", path(B, FILE_SRC, "files"), { token: t.other }))).total).toBe(3);
    const r = await call("GET", path(B, FILE_SRC, "quarantine"), { token: t.other });
    expect([r.status, await code(r)]).toEqual([404, "not_found"]);
    expect((await call("GET", path(B, SNAP_SRC, "snapshots"), { token: t.other })).status).toBe(404);
  });

  it("a page past 1000 or a bad size is 400 before the session is read; a non-UUID source is 404", async () => {
    expect((await call("GET", `${path(A, FILE_SRC, "files")}?page=1001`)).status).toBe(400);
    expect((await call("GET", `${path(A, FILE_SRC, "files")}?pageSize=7`)).status).toBe(400);
    expect((await call("GET", path(A, "nope", "files"), { token: t.op })).status).toBe(404);
  });
});

describe("POST run", () => {
  const run = (token: string, src: string, body: unknown = {}) => call("POST", path(A, src, "run"), { token, body });

  it("source_admin queues a run once; a second while it waits joins it (queued false, no entry); others are 403", async () => {
    expect((await run(t.op, FILE_SRC)).status).toBe(403);
    expect(await json(run(t.adm, FILE_SRC))).toEqual({ queued: true });
    expect(await json(run(t.adm, FILE_SRC))).toEqual({ queued: false });
    const acts = await db.select({ action: activity.action, targetId: activity.targetId, after: activity.after }).from(activity);
    expect(acts).toEqual([{ action: "source.run", targetId: FILE_SRC, after: { businessDate: null } }]);
  });

  it("a snapshot source names its date; a closed day is 409 day_closed; a file source takes none", async () => {
    expect((await run(t.adm, SNAP_SRC)).status).toBe(400);
    expect((await run(t.adm, FILE_SRC, { businessDate: "2026-11-02" })).status).toBe(400);
    expect((await run(t.adm, SNAP_SRC, { businessDate: "2026-02-30" })).status).toBe(400);
    ingestHooks.dayClosed = async (_tx, _s, d) => d === "2026-11-02";
    const closed = await run(t.adm, SNAP_SRC, { businessDate: "2026-11-02" });
    expect([closed.status, await code(closed)]).toEqual([409, "day_closed"]);
    expect(await json(run(t.adm, SNAP_SRC, { businessDate: "2026-11-03" }))).toEqual({ queued: true });
  });

  it("a paused source is 409 invalid_state with its reason; a body that isn't JSON is 400; another space's source is 404", async () => {
    await db.update(sources).set({ status: "paused" }).where(eq(sources.id, FILE_SRC));
    await db.insert(sourceCursors).values({ spaceId: A, sourceId: FILE_SRC, lastError: "act20261104.txt: The header has 15 columns; the source declares 14" });
    const r = await run(t.adm, FILE_SRC);
    expect([r.status, await code(r)]).toEqual([409, "invalid_state"]);
    expect((await call("POST", path(A, SNAP_SRC, "run"), { token: t.adm, body: "x", headers: { "Content-Type": "text/plain" } })).status).toBe(400);
    const other = await source(B, "file_inbox");
    expect((await run(t.adm, other)).status).toBe(404);
  });

  it("an archived space refuses a run with 409 space_archived", async () => {
    await db.update(spaces).set({ status: "archived" }).where(eq(spaces.id, A));
    const r = await run(t.adm, FILE_SRC);
    expect([r.status, await code(r)]).toEqual([409, "space_archived"]);
  });
});

// ------------------------------------------------------------------------------------------------ read model
// GET /v1/spaces/:spaceId/sources and /:sourceId carry what the screens show (ingest sourceStates): health, the
// business date's records and quarantine, the owner of a shared source, the next run and a paused source's drift.
describe("the sources list and detail read model", () => {
  const today = () => todayIn(new Date());
  /** The date a file or snapshot source is judged on now: the business day before today (sourceHealth's rule). */
  const D = () => previousBusinessDay(makeCalendar(idDefault), today());
  const list = async (s: string, token: string) => (await json<Page<SourceRowDto>>(call("GET", `/v1/spaces/${s}/sources`, { token }))).items;
  const detail = (s: string, src: string, token: string) => json<SourceDto>(call("GET", `/v1/spaces/${s}/sources/${src}`, { token }));
  const record = (sourceId: string, businessDate: string, n: number) => ({
    id: Bun.randomUUIDv7(), spaceId: A, sourceId, sourceVersionId: Bun.randomUUIDv7(), businessDate, bdayIndex: 1, attrs: {}, rowHash: `h${n}`, originId: Bun.randomUUIDv7(),
  });

  beforeEach(async () => {
    await db.transaction((tx) => ensureMonthPartitions(tx, records, new Date(`${D()}T00:00:00Z`), 1));
    const fileId = Bun.randomUUIDv7();
    await db.insert(sourceFiles).values({
      id: fileId, spaceId: A, sourceId: FILE_SRC, name: "act-today.txt", sha256: "shaD", size: 10, modifiedAt: new Date(), status: "ingested", version: 1, businessDate: D(),
    });
    await db.insert(records).values([record(FILE_SRC, D(), 1), record(FILE_SRC, D(), 2), record(FILE_SRC, "2026-11-02", 3)]);
    await db.insert(quarantineRows).values({ id: Bun.randomUUIDv7(), spaceId: A, sourceId: FILE_SRC, origin: "file", originId: fileId, lineNo: 3, raw: "x", rawHash: "hx", reasons: {}, businessDate: D() });
  });

  it("a quarantined line names the file it came in, with the file's version; a line of an unknown origin names none", async () => {
    const q = await json<Page<QuarantineRowDto>>(call("GET", path(A, FILE_SRC, "quarantine"), { token: t.op }));
    expect(q.items.map((r) => [r.line, r.file])).toEqual([[3, { name: "act-today.txt", version: 1 }], [12, null]]);
  });

  it("the owner space: health, the business date's records and quarantine, no owner", async () => {
    const rows = await list(A, t.op);
    expect(rows.find((r) => r.id === FILE_SRC)).toMatchObject({
      shared: false, owner: null, rowsToday: 2, quarantinedToday: 1,
      health: { state: "healthy", businessDate: D(), reason: null, missingDate: null, lastError: null },
    });
    // no active snapshot for D yet and no deadline set: degraded, never down
    expect(rows.find((r) => r.id === SNAP_SRC)).toMatchObject({
      rowsToday: 0, quarantinedToday: 0, health: { state: "degraded", businessDate: D(), reason: `No active snapshot for ${D()}`, missingDate: D() },
    });
    expect(rows[0]!.health).not.toHaveProperty("deadline");
  });

  it("the space it is shared to: the owner's name and the health, no quarantine count", async () => {
    const [row] = await list(B, t.other);
    expect(row).toMatchObject({ id: FILE_SRC, shared: true, owner: { spaceId: A, name: "TREASURY" }, rowsToday: 2, quarantinedToday: null, health: { state: "healthy" } });
    expect(await detail(B, FILE_SRC, t.other)).toMatchObject({ owner: { spaceId: A, name: "TREASURY" }, quarantinedToday: null, drift: null });
  });

  it("a deadline that passed makes a missing snapshot down; the detail names the inputs and the next run", async () => {
    await db.update(sourceVersions).set({ spec: { ...ksei(), input: { kind: "db_snapshot", query: "select 1 where :business_date is not null", schedule: "0 6 * * *" }, health: { deadline: "00:00" } } })
      .where(eq(sourceVersions.sourceId, SNAP_SRC));
    const d = await detail(A, SNAP_SRC, t.op);
    expect(d.health).toMatchObject({ state: "down", graceMinutes: null, deadline: "00:00", reason: `No active snapshot for ${D()}` });
    const next = new Date(d.nextRunAt!);
    expect(next.getTime()).toBeGreaterThan(Date.now());
    expect([next.getUTCHours(), next.getUTCMinutes()]).toEqual([23, 0]); // 06:00 WIB
  });

  it("a paused source: down with its last error and the drift per column; no next run", async () => {
    const drift = [{ column: "gone", expected: "string", found: null, effect: "The column is gone, so it can't be read." }];
    await db.update(sources).set({ status: "paused" }).where(eq(sources.id, SNAP_SRC));
    await db.insert(sourceCursors).values({ spaceId: A, sourceId: SNAP_SRC, lastError: "Column \"gone\" is no longer in the query.", drift });
    const d = await detail(A, SNAP_SRC, t.op);
    expect(d).toMatchObject({ nextRunAt: null, health: { state: "down", lastError: "Column \"gone\" is no longer in the query." }, drift: { columns: drift } });
    expect(typeof d.drift?.checkedAt).toBe("string");
    // active again: an old drift is not shown
    await db.update(sources).set({ status: "active" }).where(eq(sources.id, SNAP_SRC));
    expect((await detail(A, SNAP_SRC, t.op)).drift).toBeNull();
  });

  it("a source without a published version has no health or counts", async () => {
    await db.update(sourceVersions).set({ status: "draft" }).where(eq(sourceVersions.sourceId, SNAP_SRC));
    expect((await list(A, t.op)).find((r) => r.id === SNAP_SRC)).toMatchObject({ publishedVersion: null, health: null, rowsToday: null, quarantinedToday: null });
  });

  it("each snapshot row says whether its day is closed (ingestHooks.dayClosed)", async () => {
    const p = () => json<Page<SourceSnapshotDto>>(call("GET", path(A, SNAP_SRC, "snapshots"), { token: t.op }));
    expect((await p()).items.map((x) => x.closed)).toEqual([false, false]);
    ingestHooks.dayClosed = async (_tx, _s, d) => d === "2026-11-02";
    expect((await p()).items.map((x) => x.closed)).toEqual([true, true]);
  });
});
