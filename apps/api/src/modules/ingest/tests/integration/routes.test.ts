// /v1/spaces/:spaceId/sources/:sourceId/{files,snapshots,quarantine,run}: roles, check order, paging, what a space
// a source is shared to may read, the run now (queued once, activity entry, day_closed, paused).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Page } from "@starterkit/shared/contracts/common";
import type { QuarantineRowDto, SourceFileDto, SourceSnapshotDto } from "@starterkit/shared/contracts/sources";
import type { SpaceRole } from "@starterkit/shared/spaces";
import { eq } from "drizzle-orm";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { db } from "../../../../kernel/db";
import { activity } from "../../../audit";
import { sourceShares, sources, sourceVersions } from "../../../sources";
import { spaceMembers, spaces } from "../../../spaces";
import { users } from "../../../users";
import { quarantineRows, sourceCursors, sourceFiles, sourceSnapshots } from "../../schema";
import { ingestHooks } from "../../service";
import { ksei } from "../unit/fixtures";

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
  await db.insert(quarantineRows).values({ id: Bun.randomUUIDv7(), spaceId: A, sourceId: FILE_SRC, origin: "file", originId: Bun.randomUUIDv7(), lineNo: 12, raw: "A1|B1", reasons: { sid: "sid is required" }, businessDate: "2026-11-02" });
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
