// The recon dashboard (GET /v1/dashboard/recon, engine dashboard.ts) and the list filters its links use: every number
// it links equals what that list answers for the same filters; spaces in scope only (a Superadmin every space);
// currencies kept apart.
import { beforeEach, describe, expect, it } from "bun:test";
import type { Page } from "@starterkit/shared/contracts/common";
import type { ActionRunRowDto, BreakSummaryDto } from "@starterkit/shared/contracts/breaks";
import { ReconDashboardDto } from "@starterkit/shared/contracts/dashboard";
import type { ResultCountsDto } from "@starterkit/shared/contracts/results";
import { REQUEST_KINDS } from "@starterkit/shared/approvals";
import { AGE_GROUPS, CLOSED_PARTS, RESOLVED_STATUSES } from "@starterkit/shared/dashboard";
import { call, signIn } from "../../../../../test/helpers/app";
import { db } from "../../../../kernel/db";
import { actionRuns } from "../../../integrations";
import { withSpace } from "../../../spaces";
import { recomputeDayStats } from "../../stats";
import { D, D1, type DashboardFixture, noon, rollup, seedDashboard } from "../dashboard-fixture";

let F: DashboardFixture;
beforeEach(async () => { F = await seedDashboard(); });
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;

describe("Posting list: recon and period filters", () => {
  it("dateFrom/dateTo take the day a run finished (Asia/Jakarta), recon its recon", async () => {
    const token = await signIn("viewer");
    const list = (qs: string) => json<Page<ActionRunRowDto>>(call("GET", `/v1/spaces/${F.A}/action-runs?kind=posting&${qs}`, { token }));
    expect((await list("")).total).toBe(4);
    expect((await list(`dateFrom=${D}&dateTo=${D1}`)).total).toBe(3);
    expect((await list(`dateFrom=${D}&dateTo=${D}&status=failed&status=timeout&status=not_sent`)).total).toBe(1);
    expect((await list(`recon=${F.R1.configId}&dateFrom=${D}&dateTo=${D1}`)).total).toBe(3);
    expect((await list(`recon=${F.R2.configId}`)).total).toBe(0);
  });

  it("the period's edges are Asia/Jakarta midnights on the raw time, in the list and the dashboard alike (M4)", async () => {
    const [r] = await db.select().from(actionRuns).limit(1);
    const at = (s: string) => new Date(`${s}+07:00`);
    // last instant of D1 in, first instant of the next day out
    await db.insert(actionRuns).values([
      { ...r!, id: Bun.randomUUIDv7(), seq: 10, actionIndex: 10, status: "failed", createdAt: at(`${D1}T23:59:59.999`), finishedAt: at(`${D1}T23:59:59.999`) },
      { ...r!, id: Bun.randomUUIDv7(), seq: 11, actionIndex: 11, status: "failed", createdAt: at("2026-11-04T00:00:00"), finishedAt: at("2026-11-04T00:00:00") },
    ]);
    const token = await signIn("viewer");
    const list = await json<Page<ActionRunRowDto>>(call("GET", `/v1/spaces/${F.A}/action-runs?kind=posting&dateFrom=${D}&dateTo=${D1}`, { token }));
    expect(list.total).toBe(4);
    const d = await body(token);
    expect([d.posting.finished, d.posting.failed]).toEqual([4, 3]);
    const next = await body(token, `from=2026-11-04&to=2026-11-04`);
    expect([next.posting.failed, next.posting.prevFinished]).toEqual([1, 2]);
  });
});

const dash = (token: string, qs = `from=${D}&to=${D1}`) => call("GET", `/v1/dashboard/recon?${qs}`, { token });
const body = async (token: string, qs?: string) => { const r = await dash(token, qs); expect(r.status).toBe(200); return ReconDashboardDto.parse(await r.json()); };
/** The rollup written as the nightly sweep would on D1. */
const sweep = () => rollup(noon(D1));

describe("GET /v1/dashboard/recon: scope", () => {
  it("needs a session; a bad period is 400 before it", async () => {
    expect((await call("GET", "/v1/dashboard/recon")).status).toBe(401);
    expect((await call("GET", `/v1/dashboard/recon?from=${D1}&to=${D}`)).status).toBe(400);
    expect((await call("GET", `/v1/dashboard/recon?from=${D}`)).status).toBe(400);
    expect((await call("GET", "/v1/dashboard/recon?space=nope")).status).toBe(400);
  });

  it("the spaces the viewer holds a role in; a Superadmin every space; no role, nothing", async () => {
    expect((await body(await signIn("viewer"))).spaces.map((s) => s.id)).toEqual([F.A]);
    expect((await body(await signIn("google"))).spaces.map((s) => s.id).sort()).toEqual([F.A, F.B].sort());
    expect((await body(await signIn("superadmin"))).spaces.map((s) => s.id).sort()).toEqual([F.A, F.B, F.C].sort());
    const none = await body(await signIn("admin"));
    expect([none.spaces, none.recons, none.rows, none.open.count]).toEqual([[], [], [], 0]);
  });

  it("a space or recon outside the scope is 404, and another space's data never shows", async () => {
    await sweep();
    const t = await signIn("viewer");
    expect((await dash(t, `space=${F.B}`)).status).toBe(404);
    expect((await dash(t, `recon=${F.RB.configId}`)).status).toBe(404);
    const d = await body(t);
    expect(d.rows.map((r) => r.id).sort()).toEqual([F.R1.configId, F.R2.configId].sort());
    // per currency, never summed across; as the Unmatch summary orders them (most items, then the larger amount)
    expect(d.open.amounts).toEqual([{ currency: "USD", amountMinor: "700", items: 1 }, { currency: "IDR", amountMinor: "500", items: 1 }]);
    const b = await body(await signIn("apple"));
    expect(b.rows.map((r) => r.id)).toEqual([F.RB.configId]);
    expect(b.posting.finished).toBe(0);
    expect(b.approvals.waiting).toBe(0);
  });
});

describe("GET /v1/dashboard/recon: numbers", () => {
  it("across spaces: summed per space, currencies kept apart", async () => {
    await sweep();
    const d = await body(await signIn("google"));
    expect(d.autoRate).toEqual({ rows: 2, matched: 4, records: 11, prevMatched: 0, prevRecords: 0 });
    expect(d.open).toMatchObject({ count: 3, broke: 5, prevBroke: 0, amounts: [{ currency: "IDR", amountMinor: "1500", items: 2 }, { currency: "USD", amountMinor: "700", items: 1 }] });
    expect(d.resolved).toEqual({ rows: 2, prevRows: 0, medianMinutes: 1440 });
    expect(d.posting).toEqual({ posted: 1, finished: 3, failed: 2, prevPosted: 0, prevFinished: 0 });
    expect(d.approvals).toMatchObject({ waiting: 1, oldestAt: noon(D).toISOString(), requested: 2, prevRequested: 0, decided: 1, rejected: 1, medianMinutes: 1440 });
    expect(d.days).toEqual([{ date: D, auto: 4, manual: 2, broke: 5, matched: 4, records: 10 }, { date: D1, auto: 0, manual: 0, broke: 0, matched: 0, records: 1 }]);
    expect(d.writtenOff).toEqual([{ currency: "IDR", amountMinor: "900", items: 1 }]);
    expect(d.bySpace.map((s) => [s.name, s.open, s.amounts, s.matched, s.records])).toEqual([
      ["Ops", 1, [{ currency: "IDR", amountMinor: "1000", items: 1 }], 0, 1],
      ["Treasury", 2, [{ currency: "USD", amountMinor: "700", items: 1 }, { currency: "IDR", amountMinor: "500", items: 1 }], 4, 10],
    ]);
    expect(d.age.reduce((n, a) => n + a.count, 0)).toBe(3);
    expect(d.reasons).toEqual([{ reason: "No counterpart", count: 2 }, { reason: "Amount differs", count: 1 }]);
    const r1 = d.rows.find((r) => r.id === F.R1.configId)!;
    expect(r1).toMatchObject({ spaceName: "Treasury", records: 8, matched: 2, open: 2, oldest: D, postingFailed: 2, lastRun: { status: "succeeded" } });
  });

  it("every linked number equals its list for the same filters", async () => {
    await sweep();
    const t = await signIn("viewer");
    const get = <T>(path: string) => json<T>(call("GET", path, { token: t }));
    for (const recon of [null, F.R1.configId]) {
      const qs = recon ? `recon=${recon}` : "";
      const d = await body(t, `from=${D}&to=${D1}${recon ? `&${qs}` : ""}`);
      // Unmatch open = the Unmatch list's summary; by age and reason = its filter counts
      const s = await get<BreakSummaryDto>(`/v1/spaces/${F.A}/breaks/summary?${qs}`);
      expect([d.open.count, d.open.amounts, d.open.pastCarryOver]).toEqual([s.open, s.amounts, s.pastCarryOver]);
      const facets = await get<{ reason: Record<string, number>; age: Record<string, number> }>(`/v1/spaces/${F.A}/breaks/facets?${qs}`);
      expect(Object.fromEntries(d.reasons.map((r) => [r.reason, r.count]))).toEqual(facets.reason);
      for (const g of AGE_GROUPS) expect(d.age.find((a) => a.key === g.key)!.count).toBe(g.buckets.reduce((n, b) => n + (facets.age[b] ?? 0), 0));
      for (const g of AGE_GROUPS) {
        const one = await get<BreakSummaryDto>(`/v1/spaces/${F.A}/breaks/summary?${[qs, ...g.buckets.map((b) => `age=${b}`)].filter(Boolean).join("&")}`);
        expect(d.age.find((a) => a.key === g.key)!.amounts).toEqual(one.amounts);
      }
      // Posting failures = the Posting list filtered to its failed statuses, the recon and the period
      const failed = await get<Page<ActionRunRowDto>>(`/v1/spaces/${F.A}/action-runs?kind=posting&status=failed&status=timeout&status=not_sent&dateFrom=${D}&dateTo=${D1}${recon ? `&${qs}` : ""}`);
      expect(d.posting.failed).toBe(failed.total);
      // Waiting approval = the inbox of every break request of the space
      const inbox = await get<Page<unknown>>(`/v1/spaces/${F.A}/approvals?${REQUEST_KINDS.map((k) => `kind=${k}`).join("&")}`);
      expect(d.approvals.waiting).toBe(inbox.total);
    }
    // a recon's closed parts and Resolved = Operation result's counts for its period
    const d = await body(t, `from=${D}&to=${D1}&recon=${F.R1.configId}`);
    const { counts } = await get<ResultCountsDto>(`/v1/spaces/${F.A}/recons/${F.R1.configId}/results/counts?dateFrom=${D}&dateTo=${D1}`);
    for (const p of CLOSED_PARTS) expect(d.closed.find((c) => c.key === p.key)!.rows).toBe(p.statuses.reduce((n, s) => n + (counts[s] ?? 0), 0));
    expect(d.resolved.rows).toBe(RESOLVED_STATUSES.reduce((n, s) => n + (counts[s] ?? 0), 0));
    // the Auto-match tile's rows = the list it opens (result=matched)
    expect(d.autoRate.rows).toBe(counts.matched ?? 0);
    expect(d.rows.map((r) => r.id)).toEqual([F.R1.configId]);
  });

  it("names the dates with results whose rollup isn't written yet, in the period and the one before (C2)", async () => {
    const t = await signIn("viewer");
    // nothing rolled up: D and D1 hold results (R1, R2), the days before none
    expect((await body(t)).pending).toEqual({ days: 2, prevDays: 0 });
    expect((await body(t, `from=${D1}&to=2026-11-04`)).pending).toEqual({ days: 1, prevDays: 1 });
    await withSpace({ spaceIds: [F.A], userId: null }, (tx) => recomputeDayStats(tx, F.A, F.R1.configId, D));
    // D still waits on R2's row; the recon filter narrows to R1's
    expect((await body(t)).pending).toEqual({ days: 2, prevDays: 0 });
    expect((await body(t, `from=${D}&to=${D1}&recon=${F.R1.configId}`)).pending).toEqual({ days: 1, prevDays: 0 });
    await sweep();
    expect((await body(t)).pending).toEqual({ days: 0, prevDays: 0 });
  });

  it("the previous period compares the same number of days just before", async () => {
    await sweep();
    const d = await body(await signIn("viewer"), `from=${D1}&to=2026-11-04`);
    expect([d.period, d.previous]).toEqual([{ from: D1, to: "2026-11-04" }, { from: "2026-11-01", to: D }]);
    expect(d.autoRate).toMatchObject({ matched: 0, records: 1, prevMatched: 4, prevRecords: 9 });
  });
});
