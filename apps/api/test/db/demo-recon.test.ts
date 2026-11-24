// The trial's demo recons (db/seed/demo-recon.ts): after seedDemo + seedDemoRecon every main screen answers with data,
// read through the API as the screens read it; a second run adds nothing.
import { beforeAll, describe, expect, it } from "bun:test";
import type { BreakRowDto } from "@starterkit/shared/contracts/breaks";
import type { Page } from "@starterkit/shared/contracts/common";
import type { ReconDashboardDto } from "@starterkit/shared/contracts/dashboard";
import type { NavCountsDto, TodayDto } from "@starterkit/shared/contracts/recon";
import type { ResultCountsDto } from "@starterkit/shared/contracts/results";
import { and, count, eq, inArray, isNotNull } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { DEMO_RECONS, demoRows, seedDemoRecon } from "../../src/db/seed/demo-recon";
import { db } from "../../src/kernel/db";
import { approvalRequests } from "../../src/modules/approvals";
import { reconItems, reconRuns } from "../../src/modules/engine";
import { records } from "../../src/modules/ingest";
import { connectors } from "../../src/modules/integrations";
import { reconConfigs } from "../../src/modules/recon";
import { spaceMembers, spaces } from "../../src/modules/spaces";
import { users } from "../../src/modules/users";
import { call, resetData, signIn } from "../helpers/app";

const json = async <T>(r: Promise<Response>) => {
  const res = await r;
  expect(res.status).toBe(200);
  return (await res.json()) as T;
};
let T: string, cfg: Record<string, string>;

/** Rows of the tables the demo recon writes, for the second-run check. */
async function tally() {
  const n = async (t: PgTable) => (await db.select({ n: count() }).from(t))[0]!.n;
  return { records: await n(records), items: await n(reconItems), runs: await n(reconRuns), requests: await n(approvalRequests), connectors: await n(connectors),
    assigned: (await db.select({ n: count() }).from(reconItems).where(isNotNull(reconItems.assigneeId)))[0]!.n };
}

beforeAll(async () => {
  await resetData();
  await seedDemoRecon(db);
  T = (await db.select({ id: spaces.id }).from(spaces).where(eq(spaces.code, "treasury")))[0]!.id;
  cfg = Object.fromEntries((await db.select({ code: reconConfigs.code, id: reconConfigs.id }).from(reconConfigs)
    .where(inArray(reconConfigs.code, Object.values(DEMO_RECONS)))).map((c) => [c.code, c.id]));
}, 60_000);

describe("seedDemoRecon", () => {
  it("the generator is deterministic and mostly pairs, with every kind of difference", () => {
    const dates = ["2026-11-17", "2026-11-18"];
    expect(demoRows(dates)).toEqual(demoRows(dates));
    const rows = demoRows(dates);
    const a = rows.filter((r) => r.side === "a").length, b = rows.filter((r) => r.side === "b").length;
    expect(a + b).toBeGreaterThan(200);
    expect(a).not.toBe(b);
  });

  it("Operation result, Unmatch, Today, the dashboard and the sidebar counts answer with data", async () => {
    const token = await signIn("superadmin");
    expect(Object.keys(cfg).sort()).toEqual([DEMO_RECONS.twoWay, DEMO_RECONS.oneWay].sort());
    for (const id of Object.values(cfg)) {
      const counts = await json<ResultCountsDto>(call("GET", `/v1/spaces/${T}/recons/${id}/results/counts`, { token }));
      expect(counts.counts.matched ?? 0).toBeGreaterThan(0);
    }
    const breaks = await json<Page<BreakRowDto>>(call("GET", `/v1/spaces/${T}/breaks`, { token }));
    expect(breaks.total).toBeGreaterThan(0);
    const today = await json<TodayDto>(call("GET", `/v1/spaces/${T}/today`, { token }));
    expect(today.recons.length).toBeGreaterThanOrEqual(2);
    const dash = await json<ReconDashboardDto>(call("GET", "/v1/dashboard/recon", { token }));
    expect(dash.autoRate.matched).toBeGreaterThan(0);
    expect(dash.open.count).toBeGreaterThan(0);
    const nav = await json<NavCountsDto>(call("GET", `/v1/spaces/${T}/nav-counts`, { token }));
    expect(nav.unmatch).toBeGreaterThan(0);
    // the write-off waits for Treasury's reviewer
    const [reviewer] = await db.select({ username: users.username }).from(spaceMembers).innerJoin(users, eq(users.id, spaceMembers.userId))
      .where(and(eq(spaceMembers.spaceId, T), eq(spaceMembers.role, "reviewer")));
    const navReviewer = await json<NavCountsDto>(call("GET", `/v1/spaces/${T}/nav-counts`, { token: await signIn(reviewer!.username) }));
    expect(navReviewer.approvals).toBe(1);
    const t = await tally();
    expect(t.requests).toBe(1);
    expect(t.assigned).toBeGreaterThanOrEqual(2);
    expect(t.connectors).toBe(1);
  });

  it("a second run changes nothing", async () => {
    const before = await tally();
    await seedDemoRecon(db);
    expect(await tally()).toEqual(before);
  });
});
