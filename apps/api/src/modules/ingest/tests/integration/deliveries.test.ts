// deliveryCounts as the app role (row level security on): a date is due by the source's own rule and every space's
// recons reading it (recon_source_due, drizzle/0068), whoever asks; a pulled source's watermark type decides whether it
// has a time it is complete to.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { SourceSpec } from "@starterkit/shared/contracts/sources";
import { eq } from "drizzle-orm";
import { appRoleDb } from "../../../../../test/helpers/app-role";
import { truncateAll } from "../../../../../test/helpers/db";
import { db } from "../../../../kernel/db";
import { reconConfigs, reconConfigVersions, reconSourceUses } from "../../../recon";
import { calendars, sources, sourceShares, sourceVersions } from "../../../sources";
import { spaces, withSpace } from "../../../spaces";
import { sourceCursors, sourceDeliveries, sourceFiles } from "../../schema";
import { type DeliverySource, deliveryCounts } from "../../service";
import { ksei } from "../unit/fixtures";

const A = Bun.randomUUIDv7(), B = Bun.randomUUIDv7();
const D = "2026-11-03", D1 = "2026-11-04"; // Tue, Wed
const NOW = new Date("2026-11-20T00:00:00Z");
const jkt = (s: string) => new Date(`${s}+07:00`);
let probe: Awaited<ReturnType<typeof appRoleDb>>;

const made = jkt("2026-10-01T00:00:00");
async function source(spec: SourceSpec): Promise<DeliverySource> {
  const id = Bun.randomUUIDv7();
  await db.insert(sources).values({ id, spaceId: A, code: `s-${id.slice(-12)}`, name: "S", kind: spec.input.kind, createdAt: made });
  await db.insert(sourceVersions).values({ id: Bun.randomUUIDv7(), spaceId: A, sourceId: id, version: 1, status: "published", spec, specHash: "h", makerId: A, publishedAt: made });
  return { id, spaceId: A, kind: spec.input.kind, spec, createdAt: made };
}
/** A published recon of space `spaceId` reading `s` with `spec`'s schedule, and its health inputs on recon_source_uses. */
async function reader(spaceId: string, s: DeliverySource, spec: object, uses: { graceMinutes?: number; deadline?: string } = {}) {
  const configId = Bun.randomUUIDv7();
  await db.insert(reconConfigs).values({ id: configId, spaceId, code: `r-${configId.slice(-12)}`, name: "R" });
  await db.insert(reconConfigVersions).values({ id: Bun.randomUUIDv7(), configId, spaceId, version: 1, status: "published", spec, specHash: "h", matchingHash: "m" });
  await db.insert(reconSourceUses).values({ spaceId, configId, sourceSpaceId: s.spaceId, sourceId: s.id, field: "sid", configName: "R", ...uses });
}
const counts = (spaceIds: string[], list: DeliverySource[]) => withSpace({ spaceIds, userId: null }, (tx) => deliveryCounts(tx, list, D, D1, NOW), probe);

beforeAll(async () => { probe = await appRoleDb(); });
afterAll(async () => { await probe.$client.close(); });
beforeEach(async () => {
  await truncateAll();
  await db.insert(spaces).values([{ id: A, code: "a", name: "A" }, { id: B, code: "b", name: "B" }]);
  await db.insert(calendars).values({ id: Bun.randomUUIDv7(), code: "id-default", name: "Default", weekend: [6, 7], holidays: [] });
});

describe("deliveryCounts: due by every space's recons, whoever asks", () => {
  it("another space's recon (through a share) closing earlier makes the date due then, for the owner space too", async () => {
    const s = await source({ ...ksei(), health: { deadline: "09:00" } });
    await db.insert(sourceShares).values({ spaceId: A, sourceId: s.id, toSpaceId: B });
    await db.insert(sourceFiles).values([D, D1].map((d) => ({ id: Bun.randomUUIDv7(), spaceId: A, sourceId: s.id, name: `act${d}`, sha256: d, size: 1, modifiedAt: made, status: "ingested", businessDate: d, rowsOk: 1 })));
    // D in at 07:00 the next morning, D1 at 06:00
    await db.insert(sourceDeliveries).values([{ spaceId: A, sourceId: s.id, businessDate: D, completedAt: jkt("2026-11-04T07:00:00") }, { spaceId: A, sourceId: s.id, businessDate: D1, completedAt: jkt("2026-11-05T06:00:00") }]);
    expect((await counts([A], [s])).get(s.id)).toEqual({ onTime: 2, late: 0, missing: 0, unknown: 0 }); // by its own 09:00
    // B's daily recon runs D on D+1 at 06:00 with 30 min grace: due D+1 06:30, though A can't read B's recon
    await reader(B, s, { schedule: { kind: "daily", at: "06:00", business_date_offset: 1 }, close_at: "23:00", grace_minutes: 30 });
    expect((await counts([A], [s])).get(s.id)).toEqual({ onTime: 1, late: 1, missing: 0, unknown: 0 });
    expect((await counts([B], [s])).get(s.id)).toEqual({ onTime: 1, late: 1, missing: 0, unknown: 0 });
    // a recon's deadline on recon_source_uses (health's input) stricter still: 05:00
    await reader(B, s, { schedule: { kind: "interval", every_minutes: 15 }, close_at: "23:59", grace_minutes: 1440 }, { deadline: "05:00" });
    expect((await counts([A], [s])).get(s.id)).toEqual({ onTime: 0, late: 2, missing: 0, unknown: 0 });
  });

  it("a recon of an archived space sets no due time", async () => {
    const s = await source({ ...ksei(), health: { deadline: "09:00" } });
    await db.insert(sourceDeliveries).values({ spaceId: A, sourceId: s.id, businessDate: D, completedAt: jkt("2026-11-04T07:00:00") });
    await db.update(spaces).set({ status: "archived" }).where(eq(spaces.id, B));
    await reader(B, s, { schedule: { kind: "daily", at: "06:00", business_date_offset: 1 }, close_at: "23:00", grace_minutes: 30 });
    expect((await counts([A], [s])).get(s.id)?.onTime).toBe(1);
  });

  it("a completion is judged by the due time kept with it", async () => {
    const s = await source({ ...ksei(), health: { deadline: "09:00" } });
    await db.insert(sourceDeliveries).values({ spaceId: A, sourceId: s.id, businessDate: D, completedAt: jkt("2026-11-04T07:00:00"), dueAt: jkt("2026-11-04T06:00:00") });
    expect((await counts([A], [s])).get(s.id)).toMatchObject({ onTime: 0, late: 1 });
  });

  it("a source whose calendar is missing answers null, not left out", async () => {
    const s = await source({ ...ksei(), calendar: "gone" });
    const out = await counts([A], [s]);
    expect([out.has(s.id), out.get(s.id)]).toEqual([true, null]);
  });
});

describe("deliveryCounts: a pulled source's watermark", () => {
  const pulled = (o: Partial<SourceSpec> = {}): SourceSpec => ({
    ...ksei(), ...o, input: { kind: "db_watermark", table: "t", watermark: { column: "updated_at", id_columns: ["id"] }, lookback_seconds: 0, chunk: 100 },
  } as SourceSpec);
  const cursor = (s: DeliverySource, type: string) => db.insert(sourceCursors).values({ spaceId: A, sourceId: s.id, lastSuccessAt: NOW, columns: [{ name: "updated_at", type }, { name: "id", type: "bigint" }] });

  it("a date or time watermark that never moved is missing once due; a sequence number is unknown", async () => {
    const time = await source(pulled()), seq = await source(pulled());
    await cursor(time, "timestamp with time zone");
    await cursor(seq, "bigint");
    const out = await counts([A], [time, seq]);
    expect(out.get(time.id)).toEqual({ onTime: 0, late: 0, missing: 2, unknown: 0 });
    expect(out.get(seq.id)).toEqual({ onTime: 0, late: 0, missing: 0, unknown: 2 });
  });
});

