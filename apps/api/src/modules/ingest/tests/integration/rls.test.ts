// Row level security of the ingest tables as the app role (asAppRole: the test database connects as a superuser, which
// skips every policy): the owner space sees all of it; a space the source is shared to reads its records, raw rows,
// cursor, snapshots and files (DEC-042), never its quarantine, and writes none of them; any other space sees nothing.
import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { asAppRole } from "../../../../../test/helpers/app-role";
import { truncateAll } from "../../../../../test/helpers/db";
import { db, type InTx } from "../../../../kernel/db";
import { ensureMonthPartitions } from "../../../../kernel/partitions";
import { sourceShares, sources, sourceVersions } from "../../../sources";
import { spaces, withSpace } from "../../../spaces";
import { quarantineRows, rawRows, records, sourceCursors, sourceFiles, sourceSnapshots } from "../../schema";

const A = Bun.randomUUIDv7(), B = Bun.randomUUIDv7(), C = Bun.randomUUIDv7();
const SRC = Bun.randomUUIDv7(), V1 = Bun.randomUUIDv7(), FILE = Bun.randomUUIDv7(), SNAP = Bun.randomUUIDv7();
const U = Bun.randomUUIDv7();
const DAY = "2026-11-02";
const errno = (e: unknown) => ((e as { cause?: { errno?: string } }).cause ?? (e as { errno?: string })).errno;

const as = <T>(spaceIds: string[], fn: (tx: InTx) => Promise<T>) => withSpace({ spaceIds, userId: U }, async (tx) => {
  await asAppRole(tx);
  return fn(tx);
});
const seen = (spaceIds: string[]) => as(spaceIds, async (tx) => ({
  records: (await tx.select({ id: records.id }).from(records)).length,
  raw: (await tx.select({ id: rawRows.id }).from(rawRows)).length,
  cursors: (await tx.select({ id: sourceCursors.sourceId }).from(sourceCursors)).length,
  snapshots: (await tx.select({ id: sourceSnapshots.id }).from(sourceSnapshots)).length,
  files: (await tx.select({ id: sourceFiles.id }).from(sourceFiles)).length,
  quarantine: (await tx.select({ id: quarantineRows.id }).from(quarantineRows)).length,
}));

beforeEach(async () => {
  await truncateAll();
  await db.transaction(async (tx) => {
    await ensureMonthPartitions(tx, records, new Date(DAY), 1);
    await ensureMonthPartitions(tx, rawRows, new Date(DAY), 1);
  });
  await db.insert(spaces).values([{ id: A, code: "a", name: "A" }, { id: B, code: "b", name: "B" }, { id: C, code: "c", name: "C" }]);
  await db.insert(sources).values({ id: SRC, spaceId: A, code: "ksei", name: "KSEI ACT", kind: "file_inbox" });
  await db.insert(sourceVersions).values({ id: V1, spaceId: A, sourceId: SRC, version: 1, status: "published", spec: {}, specHash: "h", makerId: U });
  await db.insert(sourceShares).values({ spaceId: A, sourceId: SRC, toSpaceId: B });
  await db.insert(sourceFiles).values({ id: FILE, spaceId: A, sourceId: SRC, name: "act20261102.txt", sha256: "s", size: 1, modifiedAt: new Date(), status: "ingested" });
  await db.insert(sourceSnapshots).values({ id: SNAP, spaceId: A, sourceId: SRC, businessDate: DAY, status: "active" });
  await db.insert(sourceCursors).values({ spaceId: A, sourceId: SRC });
  await db.insert(rawRows).values({ id: Bun.randomUUIDv7(), spaceId: A, sourceId: SRC, origin: "file", originId: FILE, lineNo: 1, payload: { sid: "S1" }, rowHash: "h1", businessDate: DAY });
  await db.insert(records).values({ id: Bun.randomUUIDv7(), spaceId: A, sourceId: SRC, sourceVersionId: V1, businessDate: DAY, bdayIndex: 1, attrs: {}, rowHash: "h1", originId: FILE });
  await db.insert(quarantineRows).values({ id: Bun.randomUUIDv7(), spaceId: A, sourceId: SRC, origin: "file", originId: FILE, lineNo: 2, raw: "x", reasons: {} });
});

describe("ingest tables under row level security", () => {
  it("the owner space sees everything; the space it is shared to all but the quarantine; another space nothing", async () => {
    expect(await seen([A])).toEqual({ records: 1, raw: 1, cursors: 1, snapshots: 1, files: 1, quarantine: 1 });
    expect(await seen([B])).toEqual({ records: 1, raw: 1, cursors: 1, snapshots: 1, files: 1, quarantine: 0 });
    expect(await seen([C])).toEqual({ records: 0, raw: 0, cursors: 0, snapshots: 0, files: 0, quarantine: 0 });
  });

  it("the space it is shared to can't change any of it: updates touch no row, inserts fail the policy", async () => {
    const changed = await as([B], async (tx) => ({
      records: (await tx.update(records).set({ supersededBy: SRC }).returning()).length,
      snapshots: (await tx.update(sourceSnapshots).set({ status: "failed" }).where(eq(sourceSnapshots.id, SNAP)).returning()).length,
      cursors: (await tx.delete(sourceCursors).returning()).length,
      files: (await tx.delete(sourceFiles).returning()).length,
    }));
    expect(changed).toEqual({ records: 0, snapshots: 0, cursors: 0, files: 0 });
    const e = await as([B], (tx) => tx.insert(records).values({
      id: Bun.randomUUIDv7(), spaceId: A, sourceId: SRC, sourceVersionId: V1, businessDate: DAY, bdayIndex: 1, attrs: {}, rowHash: "h2", originId: FILE,
    })).catch((x: unknown) => x);
    expect(errno(e)).toBe("42501");
  });

  it("ending the share hides it all again", async () => {
    await db.delete(sourceShares);
    expect(await seen([B])).toEqual({ records: 0, raw: 0, cursors: 0, snapshots: 0, files: 0, quarantine: 0 });
  });
});
