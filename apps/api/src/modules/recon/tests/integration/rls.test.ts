// Row level security of the recon tables as the app role (asAppRole: the test database connects as a superuser, which
// skips every policy): a space sees its own configs and versions only; the space that owns a source reads which
// published configs of another space use its fields (recon_source_uses), never the configs themselves, and writes none.
import { beforeEach, describe, expect, it } from "bun:test";
import { asAppRole } from "../../../../../test/helpers/app-role";
import { truncateAll } from "../../../../../test/helpers/db";
import { db, type InTx } from "../../../../kernel/db";
import { sources } from "../../../sources";
import { spaces, withSpace } from "../../../spaces";
import { reconConfigs, reconConfigVersions, reconSourceUses } from "../../schema";
import { reconsUsingFields } from "../../service";

const A = Bun.randomUUIDv7(), B = Bun.randomUUIDv7(), C = Bun.randomUUIDv7();
const SRC = Bun.randomUUIDv7(), CFG = Bun.randomUUIDv7(), V1 = Bun.randomUUIDv7(), U = Bun.randomUUIDv7();
const errno = (e: unknown) => ((e as { cause?: { errno?: string } }).cause ?? (e as { errno?: string })).errno;

const as = <T>(spaceIds: string[], fn: (tx: InTx) => Promise<T>) => withSpace({ spaceIds, userId: U }, async (tx) => {
  await asAppRole(tx);
  return fn(tx);
});
const seen = (spaceIds: string[]) => as(spaceIds, async (tx) => ({
  configs: (await tx.select({ id: reconConfigs.id }).from(reconConfigs)).length,
  versions: (await tx.select({ id: reconConfigVersions.id }).from(reconConfigVersions)).length,
  uses: (await tx.select({ f: reconSourceUses.field }).from(reconSourceUses)).map((u) => u.f),
}));

beforeEach(async () => {
  await truncateAll();
  await db.insert(spaces).values([{ id: A, code: "a", name: "A" }, { id: B, code: "b", name: "B" }, { id: C, code: "c", name: "C" }]);
  // source of A (shared to B), config of B on it
  await db.insert(sources).values({ id: SRC, spaceId: A, code: "s1", name: "S1", kind: "file_inbox" });
  await db.insert(reconConfigs).values({ id: CFG, spaceId: B, code: "bifast", name: "BI-FAST credit" });
  await db.insert(reconConfigVersions).values({ id: V1, configId: CFG, spaceId: B, version: 1, status: "published", spec: {}, specHash: "h", makerId: U });
  await db.insert(reconSourceUses).values({ spaceId: B, configId: CFG, sourceSpaceId: A, sourceId: SRC, field: "amount_minor", configName: "BI-FAST credit" });
});

describe("recon tables under row level security", () => {
  it("the config's space sees it all; the source's owner space sees only the use rows; another space nothing", async () => {
    expect(await seen([B])).toEqual({ configs: 1, versions: 1, uses: ["amount_minor"] });
    expect(await seen([A])).toEqual({ configs: 0, versions: 0, uses: ["amount_minor"] });
    expect(await seen([C])).toEqual({ configs: 0, versions: 0, uses: [] });
    expect(await as([A], (tx) => reconsUsingFields(tx, SRC, ["amount_minor", "ext_ref"]))).toEqual(new Map([["amount_minor", ["BI-FAST credit"]]]));
    expect(await as([C], (tx) => reconsUsingFields(tx, SRC, ["amount_minor"]))).toEqual(new Map());
  });

  it("the source's owner space can't change or add a use row", async () => {
    const changed = await as([A], async (tx) => ({
      updated: (await tx.update(reconSourceUses).set({ configName: "taken" }).returning()).length,
      deleted: (await tx.delete(reconSourceUses).returning()).length,
    }));
    expect(changed).toEqual({ updated: 0, deleted: 0 });
    const e = await as([A], (tx) => tx.insert(reconSourceUses).values({ spaceId: B, configId: CFG, sourceSpaceId: A, sourceId: SRC, field: "ext_ref", configName: "x" })).catch((x: unknown) => x);
    expect(errno(e)).toBe("42501");
  });
});
