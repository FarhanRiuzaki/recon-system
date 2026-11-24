// GET /v1/spaces/:spaceId/nav-counts: the sidebar's three numbers, each the same as the screen it stands for on the
// same data: the Unmatch list's total (no filter), the approvals inbox's "Waiting for me" total, Today's postings
// needing attention (failed, timeout or not sent in 24 h). Any role reads; each count is capped at NAV_COUNT_CAP.
import { beforeEach, describe, expect, it } from "bun:test";
import type { Page } from "@starterkit/shared/contracts/common";
import type { NavCountsDto, TodayDto } from "@starterkit/shared/contracts/recon";
import { NAV_COUNT_CAP } from "@starterkit/shared/recon";
import type { SpaceRole } from "@starterkit/shared/spaces";
import { eq } from "drizzle-orm";
import { call, platformAdmin, resetData, signIn } from "../../../../../test/helpers/app";
import { db } from "../../../../kernel/db";
import { ensureMonthPartitions } from "../../../../kernel/partitions";
import { actionRuns } from "../../../integrations";
import { reconConfigs, reconConfigVersions } from "../../../recon";
import { spaceMembers, spaces } from "../../../spaces";
import { users } from "../../../users";
import { reconItems } from "../../schema";

const idOf = async (username: string) => (await db.select({ id: users.id }).from(users).where(eq(users.username, username)))[0]!.id;
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());

let A: string, other: string, cfg: string, ver: string;
let t: Record<"op" | "chk" | "su" | "sa" | "out", string>;

beforeEach(async () => {
  await resetData();
  await db.delete(spaces);
  A = Bun.randomUUIDv7();
  other = Bun.randomUUIDv7();
  await db.insert(spaces).values([{ id: A, code: "treasury", name: "Treasury" }, { id: other, code: "ops", name: "Ops" }]);
  const grant = async (spaceId: string, username: string, role: SpaceRole) => db.insert(spaceMembers).values({ spaceId, userId: await idOf(username), role });
  await grant(A, "viewer", "operator");
  await grant(A, "google", "config_checker");
  await grant(other, "apple", "viewer");
  cfg = Bun.randomUUIDv7();
  ver = Bun.randomUUIDv7();
  await db.insert(reconConfigs).values({ id: cfg, spaceId: A, code: "bifast", name: "BI-FAST" });
  // a version in review the operator made: it waits for the checker, not for its maker
  await db.insert(reconConfigVersions).values({ id: ver, configId: cfg, spaceId: A, version: 1, status: "in_review", spec: {}, specHash: "h", matchingHash: "h", makerId: await idOf("viewer"), submittedAt: new Date() });
  await db.transaction((tx) => ensureMonthPartitions(tx, reconItems, new Date(`${today}T00:00:00Z`), 1));
  const item = (status: string, breakState: string | null = null) => ({ id: Bun.randomUUIDv7(), spaceId: A, configId: cfg, recordId: Bun.randomUUIDv7(), side: "a", status, businessDate: today, breakReason: status === "break" ? "No counterpart" : null, breakState });
  await db.insert(reconItems).values([item("break"), item("break"), item("break", "resolved"), item("open")]);
  const run = (status: string, createdAt = new Date()) => ({ id: Bun.randomUUIDv7(), spaceId: A, configVersionId: ver, actionIndex: 0, actionName: "Post", kind: "posting", event: "approved", seq: 0, status, createdAt });
  await db.insert(actionRuns).values([run("failed"), run("timeout"), run("not_sent"), run("posted"), run("failed", new Date(Date.now() - 2 * 86_400_000))]);
  t = { op: await signIn("viewer"), chk: await signIn("google"), su: await signIn("superadmin"), sa: await platformAdmin(), out: await signIn("apple") };
});

const counts = (token: string, spaceId = A) => call("GET", `/v1/spaces/${spaceId}/nav-counts`, { token });

describe("GET nav-counts", () => {
  it("answers the Unmatch total, what waits for the caller and Today's postings needing attention", async () => {
    expect(await json<NavCountsDto>(counts(t.op))).toEqual({ unmatch: 2, approvals: 0, posting: 3, capped: false });
    expect(await json<NavCountsDto>(counts(t.chk))).toEqual({ unmatch: 2, approvals: 1, posting: 3, capped: false });
  });

  it("matches the screens it stands for on the same data", async () => {
    const c = await json<NavCountsDto>(counts(t.chk));
    expect(c.unmatch).toBe((await json<Page<unknown>>(call("GET", `/v1/spaces/${A}/breaks`, { token: t.chk }))).total);
    expect(c.approvals).toBe((await json<Page<unknown>>(call("GET", `/v1/spaces/${A}/approvals?mine=1`, { token: t.chk }))).total);
    const today = await json<TodayDto>(call("GET", `/v1/spaces/${A}/today`, { token: t.chk }));
    expect(c.posting).toBe(today.posting.reduce((n, p) => n + p.failed + p.timeout + p.notSent, 0));
  });

  it("guard: 401 signed out, 403 with no role in the space or another space's member, 404 a non-UUID space; a Superadmin reads", async () => {
    expect((await call("GET", `/v1/spaces/${A}/nav-counts`)).status).toBe(401);
    expect((await counts(t.sa)).status).toBe(403);
    expect((await counts(t.out)).status).toBe(403);
    expect((await counts(t.op, "nope")).status).toBe(404);
    expect((await counts(t.su)).status).toBe(200);
    // the other space has none of A's data
    expect(await json<NavCountsDto>(counts(t.out, other))).toEqual({ unmatch: 0, approvals: 0, posting: 0, capped: false });
  });

  it("caps each count at NAV_COUNT_CAP and says so", async () => {
    await db.insert(reconItems).values(Array.from({ length: NAV_COUNT_CAP }, () => ({ id: Bun.randomUUIDv7(), spaceId: A, configId: cfg, recordId: Bun.randomUUIDv7(), side: "b", status: "break", businessDate: today, breakReason: "No counterpart" })));
    expect(await json<NavCountsDto>(counts(t.op))).toEqual({ unmatch: NAV_COUNT_CAP, approvals: 0, posting: 3, capped: true });
  });
});
