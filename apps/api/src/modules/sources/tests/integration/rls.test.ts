// Row level security of the source tables as the app role (asAppRole: the test database connects as a superuser, which
// skips every policy): a space sees its own sources; a space a source is shared to reads the source and its published
// versions, never its drafts or connection, and can't write any of them; any other space sees nothing.
import { beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { asAppRole } from "../../../../../test/helpers/app-role";
import { truncateAll } from "../../../../../test/helpers/db";
import { db, type InTx } from "../../../../kernel/db";
import { one, pageQuery } from "../../../../kernel/pagination";
import { spaces, withSpace } from "../../../spaces";
import { sourceConnections, sourceShares, sourceVersions, sources } from "../../schema";

const A = Bun.randomUUIDv7(), B = Bun.randomUUIDv7(), C = Bun.randomUUIDv7();
const SRC = Bun.randomUUIDv7(), V1 = Bun.randomUUIDv7(), V2 = Bun.randomUUIDv7();
const U = Bun.randomUUIDv7();

const errno = (e: unknown) => ((e as { cause?: { errno?: string } }).cause ?? (e as { errno?: string })).errno;

/** `fn` as the app role in a transaction scoped to `spaceIds`. */
const as = <T>(spaceIds: string[], fn: (tx: InTx) => Promise<T>) => withSpace({ spaceIds, userId: U }, async (tx) => {
  await asAppRole(tx);
  return fn(tx);
});
const seen = (spaceIds: string[]) => as(spaceIds, async (tx) => ({
  sources: (await tx.select({ id: sources.id }).from(sources)).map((r) => r.id),
  versions: (await tx.select({ id: sourceVersions.id }).from(sourceVersions)).map((r) => r.id).sort(),
  connections: (await tx.select({ id: sourceConnections.sourceId }).from(sourceConnections)).length,
  shares: (await tx.select({ to: sourceShares.toSpaceId }).from(sourceShares)).map((r) => r.to),
}));

beforeEach(async () => {
  await truncateAll();
  await db.insert(spaces).values([{ id: A, code: "a", name: "A" }, { id: B, code: "b", name: "B" }, { id: C, code: "c", name: "C" }]);
  await db.insert(sources).values({ id: SRC, spaceId: A, code: "ksei", name: "KSEI ACT", kind: "file_inbox" });
  await db.insert(sourceVersions).values([
    { id: V1, spaceId: A, sourceId: SRC, version: 1, status: "published", spec: {}, specHash: "h1", makerId: U, publishedAt: new Date() },
    { id: V2, spaceId: A, sourceId: SRC, version: 2, status: "draft", spec: {}, specHash: "h2", makerId: U },
  ]);
  await db.insert(sourceConnections).values({ spaceId: A, sourceId: SRC, engine: "postgres", secretEnc: "v1:x:y:z", options: {} });
  await db.insert(sourceShares).values({ spaceId: A, sourceId: SRC, toSpaceId: B });
});

describe("source tables under row level security", () => {
  it("the owner space sees its source, every version, the connection and the share", async () => {
    expect(await seen([A])).toEqual({ sources: [SRC], versions: [V1, V2].sort(), connections: 1, shares: [B] });
  });

  it("the space it is shared to reads the source and its published version only; another space sees nothing", async () => {
    expect(await seen([B])).toEqual({ sources: [SRC], versions: [V1], connections: 0, shares: [B] });
    expect(await seen([C])).toEqual({ sources: [], versions: [], connections: 0, shares: [] });
  });

  it("the space it is shared to can't update, delete or insert: updates and deletes touch no row, inserts fail the policy", async () => {
    const changed = await as([B], async (tx) => ({
      source: (await tx.update(sources).set({ name: "taken" }).where(eq(sources.id, SRC)).returning()).length,
      version: (await tx.update(sourceVersions).set({ status: "retired" }).where(eq(sourceVersions.id, V1)).returning()).length,
      share: (await tx.delete(sourceShares).where(eq(sourceShares.sourceId, SRC)).returning()).length,
      deleted: (await tx.delete(sources).where(eq(sources.id, SRC)).returning()).length,
    }));
    expect(changed).toEqual({ source: 0, version: 0, share: 0, deleted: 0 });
    const inserts = [
      () => as([B], (tx) => tx.insert(sources).values({ id: Bun.randomUUIDv7(), spaceId: A, code: "x", name: "X", kind: "file_inbox" })),
      () => as([B], (tx) => tx.insert(sourceVersions).values({ id: Bun.randomUUIDv7(), spaceId: A, sourceId: SRC, version: 3, status: "draft", makerId: U })),
      () => as([B], (tx) => tx.insert(sourceShares).values({ spaceId: A, sourceId: SRC, toSpaceId: C })),
    ];
    for (const insert of inserts) expect(errno(await insert().catch((e: unknown) => e))).toBe("42501");
    const [row] = await db.select({ name: sources.name }).from(sources).where(eq(sources.id, SRC));
    expect(row!.name).toBe("KSEI ACT");
  });

  it("a page counts in the scoped transaction (pageQuery `on`); counted on the pool it escapes the scope", async () => {
    await db.insert(sources).values({ id: Bun.randomUUIDv7(), spaceId: C, code: "other", name: "Other", kind: "file_inbox" });
    const page = (scoped: boolean) => as([B], (tx) => pageQuery({
      rows: tx.select({ id: sources.id }).from(sources).$dynamic(), count: tx.select(one).from(sources).$dynamic(),
      orderBy: [], query: { page: 1, pageSize: 15 }, map: (r) => r.id, on: scoped ? tx : undefined,
    }));
    expect(await page(true)).toMatchObject({ items: [SRC], total: 1 });
    // on `db` the count leaves the transaction: as this suite's superuser it sees every space (2); as the app role, none (0)
    expect(await page(false)).toMatchObject({ items: [SRC], total: 2 });
  });

  it("removing the share hides the source from that space again", async () => {
    await db.delete(sourceShares);
    expect(await seen([B])).toEqual({ sources: [], versions: [], connections: 0, shares: [] });
  });
});
