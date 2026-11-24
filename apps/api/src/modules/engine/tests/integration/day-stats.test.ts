// recon_day_stats (the dashboard's rollup, stats.ts): recomputed whole from the engine's tables, it equals a direct
// count (Operation result's counts, the items themselves) on the fixture, also after a resolution and a reversal; a
// second recompute writes the same row; another space's scope neither reads nor writes it (RLS).
import { beforeEach, describe, expect, it } from "bun:test";
import type { ResultCountsDto } from "@starterkit/shared/contracts/results";
import { and, eq, isNull, sql } from "drizzle-orm";
import { call, signIn } from "../../../../../test/helpers/app";
import { asAppRole } from "../../../../../test/helpers/app-role";
import { db, type InTx } from "../../../../kernel/db";
import { withSpace } from "../../../spaces";
import { matchGroups, reconDayStats, reconItems } from "../../schema";
import { recomputeDayStats } from "../../stats";
import { D, D1, type DashboardFixture, noon, seedDashboard } from "../dashboard-fixture";

let F: DashboardFixture;
beforeEach(async () => { F = await seedDashboard(); });

const recompute = (space: string, cfg: string, date = D) => withSpace({ spaceIds: [space], userId: null }, (tx) => recomputeDayStats(tx, space, cfg, date));
const rowOf = async (space: string, cfg: string, date = D) =>
  (await withSpace({ spaceIds: [space], userId: null }, (tx) => tx.select().from(reconDayStats).where(and(eq(reconDayStats.configId, cfg), eq(reconDayStats.businessDate, date)))))[0]!;
/** Operation result's counts of R1 on D, as its list answers them. */
async function listCounts(token: string) {
  const r = await call("GET", `/v1/spaces/${F.A}/recons/${F.R1.configId}/results/counts?dateFrom=${D}&dateTo=${D}`, { token });
  return ((await r.json()) as ResultCountsDto).counts;
}
const rowsOf = (results: unknown) => Object.fromEntries(Object.entries(results as Record<string, [number, number]>).map(([k, [rows]]) => [k, rows]));
const recordsOf = (results: unknown) => Object.values(results as Record<string, [number, number]>).reduce((n, [, r]) => n + r, 0);
/** Live items of R1 dated D, counted directly. */
const itemsOnD = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(reconItems)
  .where(and(eq(reconItems.configId, F.R1.configId), eq(reconItems.businessDate, D), isNull(reconItems.simRunId))))[0]!.n;

describe("recon_day_stats", () => {
  it("equals Operation result's counts and the items of the date", async () => {
    await recompute(F.A, F.R1.configId);
    const row = await rowOf(F.A, F.R1.configId);
    const token = await signIn("viewer");
    expect(rowsOf(row.results)).toEqual(await listCounts(token) as Record<string, number>);
    expect(rowsOf(row.results)).toEqual({ matched: 1, matched_by_hand: 1, waiting_approval: 1, unmatch: 1, written_off: 1 });
    expect(recordsOf(row.results)).toBe(await itemsOnD());
    expect((row.results as Record<string, [number, number]>).matched).toEqual([1, 2]);
    // P2, P3, P4, P5 broke; P5 written off 900 IDR; resolved P2 (a day and 12 h after D's start) and P5 (12 h)
    expect(row.broke).toBe(4);
    expect(row.writtenOff).toEqual({ IDR: ["900", 1] });
    expect([...row.resolveMinutes].sort((a, b) => a - b)).toEqual([12 * 60, 36 * 60]);
  });

  it("follows a resolution and a reversal once recomputed", async () => {
    const token = await signIn("viewer");
    const closed = await call("POST", `/v1/spaces/${F.A}/breaks/${F.I.P4}/close`, { token, body: { resolution: "DUPLICATE", note: "Sent twice" } });
    expect(closed.status).toBe(200);
    // the auto group reversed: its two items become lone rows
    await db.update(matchGroups).set({ reversedBy: Bun.randomUUIDv7(), reversedAt: noon(D) }).where(eq(matchGroups.id, F.G.auto!));
    await recompute(F.A, F.R1.configId);
    const row = await rowOf(F.A, F.R1.configId);
    expect(rowsOf(row.results)).toEqual(await listCounts(token) as Record<string, number>);
    expect(rowsOf(row.results).closed).toBe(1);
    expect(rowsOf(row.results).matched).toBe(2);
    expect(recordsOf(row.results)).toBe(await itemsOnD());
    expect(row.resolveMinutes.length).toBe(3);
  });

  it("a second recompute writes the same row", async () => {
    await recompute(F.A, F.R1.configId);
    const a = await rowOf(F.A, F.R1.configId);
    await recompute(F.A, F.R1.configId);
    const b = await rowOf(F.A, F.R1.configId);
    expect({ ...b, computedAt: null }).toEqual({ ...a, computedAt: null });
  });

  it("another space's scope neither reads nor writes a space's rows", async () => {
    await recompute(F.A, F.R1.configId);
    // as the app role (the test database connects as a superuser, which skips every policy)
    const as = <T>(space: string, fn: (tx: InTx) => Promise<T>) => withSpace({ spaceIds: [space], userId: null }, async (tx) => { await asAppRole(tx); return fn(tx); });
    expect((await as(F.A, (tx) => tx.select().from(reconDayStats))).length).toBe(1);
    expect(await as(F.B, (tx) => tx.select().from(reconDayStats))).toEqual([]);
    const e = await as(F.B, (tx) => tx.insert(reconDayStats).values({ spaceId: F.A, configId: F.R1.configId, businessDate: D1 })).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
  });
});
