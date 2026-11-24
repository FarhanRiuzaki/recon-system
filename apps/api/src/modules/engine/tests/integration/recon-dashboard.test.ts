// The recon dashboard (GET /v1/dashboard/recon, engine dashboard.ts) and the list filters its links use: every number
// it links equals what that list answers for the same filters; spaces in scope only (a Superadmin every space);
// currencies kept apart.
import { beforeEach, describe, expect, it } from "bun:test";
import type { Page } from "@starterkit/shared/contracts/common";
import type { ActionRunRowDto } from "@starterkit/shared/contracts/breaks";
import { call, signIn } from "../../../../../test/helpers/app";
import { D, D1, type DashboardFixture, seedDashboard } from "../dashboard-fixture";

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
});
