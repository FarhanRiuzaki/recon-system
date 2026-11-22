// A space's workflows (DEC-052 rev 2 §4.1): a space admin of the space or a workflow.manage holder edits; another one
// publishes (a Superadmin their own only by override); only a draft's maker saves it; names are unique per space; a
// workflow of another space is 404; archive is refused while a recon version pins it, and an archive in flight holds a
// recon version check that reads the workflow.
import { beforeEach, describe, expect, it } from "bun:test";
import type { Page } from "@starterkit/shared/contracts/common";
import type { LibraryDetailDto, LibraryRowDto, UsedByRowDto } from "@starterkit/shared/contracts/workflows";
import type { Level } from "@starterkit/shared/workflows";
import { eq } from "drizzle-orm";
import { call, platformAdmin, resetData, signIn } from "../../../../../test/helpers/app";
import { holdTx, lockWaiters } from "../../../../../test/helpers/db";
import { db } from "../../../../kernel/db";
import { activity } from "../../../audit";
import { reconConfigs, reconConfigVersions } from "../../../recon";
import { spaceMembers, spaces, withSpace } from "../../../spaces";
import { users } from "../../../users";
import { workflowFacts } from "../../workflows";
import { workflows } from "../../schema";

const idOf = async (u: string) => (await db.select({ id: users.id }).from(users).where(eq(users.username, u)))[0]!.id;
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const err = async (r: Response) => ((await r.json()) as { error: { code: string; message: string } }).error;
const reviewers: Level[] = [{ name: "Checker", groups: [{ spaceRoles: ["reviewer"], globalRoles: [], users: [], need: { kind: "any" } }] }];
let A: string, B: string;
let t: Record<"m1" | "m2" | "sa" | "sadm" | "rev", string>;
const W = (space: string, x = "") => `/v1/spaces/${space}/workflows${x}`;

async function create(token: string, name: string, space = A, levels: Level[] = reviewers) {
  return json<LibraryDetailDto>(call("POST", W(space), { token, body: { spec: { name, levels } } }));
}
async function publish(id: string, by: string, maker: string, space = A) {
  await call("POST", W(space, `/${id}/draft/submit`), { token: maker });
  return call("POST", W(space, `/${id}/review/approve`), { token: by, body: {} });
}
/** A published recon version of `space` whose unmatch approval pins `{ id, version }`. */
async function reconPinning(space: string, name: string, id: string, version = 1) {
  const configId = Bun.randomUUIDv7();
  await db.insert(reconConfigs).values({ id: configId, spaceId: space, code: name.toLowerCase().replace(/ /g, "-"), name });
  await db.insert(reconConfigVersions).values({
    id: Bun.randomUUIDv7(), configId, spaceId: space, version: 1, status: "published", specHash: "h", matchingHash: "h",
    spec: { approvals: { changes: { unmatch: { workflow: { default: { id, version }, rules: [] } } } } },
  });
  return configId;
}

beforeEach(async () => {
  await resetData();
  await db.delete(spaces);
  await db.delete(workflows);
  A = Bun.randomUUIDv7(); B = Bun.randomUUIDv7();
  await db.insert(spaces).values([{ id: A, code: "treasury", name: "Treasury" }, { id: B, code: "payments", name: "Payments" }]);
  await db.insert(spaceMembers).values([
    { spaceId: A, userId: await idOf("viewer"), role: "space_admin" }, { spaceId: A, userId: await idOf("google"), role: "reviewer" },
    { spaceId: B, userId: await idOf("google"), role: "operator" },
  ]);
  t = { m1: await signIn("admin"), m2: await platformAdmin(), sa: await signIn("superadmin"), sadm: await signIn("viewer"), rev: await signIn("google") };
});

describe("a space's workflows", () => {
  it("an editor creates, another publishes; a space admin of the space edits; a reviewer can't", async () => {
    const w = await create(t.sadm, "Checker only");
    expect(w.open).toMatchObject({ version: 1, status: "draft", spec: { name: "Checker only" } });
    expect((await err(await publish(w.id, t.sadm, t.sadm))).code).toBe("self_approval");
    expect((await json<LibraryDetailDto>(call("POST", W(A, `/${w.id}/review/approve`), { token: t.m1, body: {} }))).published).toMatchObject({ version: 1 });
    const list = await json<Page<LibraryRowDto>>(call("GET", W(A), { token: t.rev }));
    expect(list.items.map((r) => [r.name, r.published?.version, r.levels, r.reconsUsing])).toEqual([["Checker only", 1, 1, 0]]);
    expect((await call("POST", W(A), { token: t.rev, body: { spec: { name: "x", levels: reviewers } } })).status).toBe(403);
    const acts = await db.select({ action: activity.action }).from(activity).where(eq(activity.targetId, w.id));
    expect(acts.map((a) => a.action).sort()).toEqual(["workflow.create", "workflow.publish", "workflow.submit"]);
  });

  it("a workflow of another space is 404; the same name is fine in another space", async () => {
    const w = await create(t.m1, "Checker only");
    expect((await call("GET", W(B, `/${w.id}`), { token: t.m1 })).status).toBe(404);
    expect((await call("POST", W(B), { token: t.m1, body: { spec: { name: "checker ONLY", levels: reviewers } } })).status).toBe(200);
    expect((await err(await call("POST", W(A), { token: t.m1, body: { spec: { name: "checker ONLY", levels: reviewers } } }))).code).toBe("duplicate");
  });

  it("a Superadmin publishes their own only by override, with a reason", async () => {
    const w = await create(t.sa, "Mine");
    expect((await err(await publish(w.id, t.sa, t.sa))).code).toBe("self_approval");
    const o = await json<LibraryDetailDto>(call("POST", W(A, `/${w.id}/review/approve`), { token: t.sa, body: { override: true, comment: "Month end" } }));
    expect(o.published).toMatchObject({ overrideReason: "Month end" });
  });

  it("one open draft at a time; only its maker saves it", async () => {
    const w = await create(t.m1, "Checker only");
    expect((await err(await call("POST", W(A, `/${w.id}/draft`), { token: t.m1 }))).code).toBe("invalid_state");
    const r = await call("PATCH", W(A, `/${w.id}/draft`), { token: t.m2, body: { spec: { name: "Checker only", levels: [...reviewers, ...reviewers] } } });
    expect((await err(r)).code).toBe("invalid_state");
  });

  it("archive is refused while a recon version pins it, then allowed; used by marks an older pin", async () => {
    const w = await create(t.m1, "Checker only");
    await publish(w.id, t.m2, t.m1);
    const recon = await reconPinning(A, "BI-FAST credit", w.id);
    const r = await call("POST", W(A, `/${w.id}/archive`), { token: t.m1 });
    expect(r.status).toBe(409);
    expect((await err(r)).message).toContain("BI-FAST credit · Unmatch");
    // version 2 goes live: the recon still pins 1
    await call("POST", W(A, `/${w.id}/draft`), { token: t.m1 });
    await publish(w.id, t.m2, t.m1);
    const used = await json<Page<UsedByRowDto>>(call("GET", W(A, `/${w.id}/used-by`), { token: t.m1 }));
    expect(used.items.map((u) => [u.reconName, u.change, u.rules, u.pinned, u.outdated])).toEqual([["BI-FAST credit", "unmatch", ["Default"], 1, true]]);
    await db.update(reconConfigVersions).set({ status: "retired" }).where(eq(reconConfigVersions.configId, recon));
    expect((await json<LibraryDetailDto>(call("POST", W(A, `/${w.id}/archive`), { token: t.m1 }))).archived).toBe(true);
  });

  it("an archive in flight holds a recon check that reads the workflow, which then sees it archived", async () => {
    const w = await create(t.m1, "Checker only");
    await publish(w.id, t.m2, t.m1);
    const archive = await holdTx((tx) => tx.update(workflows).set({ archivedAt: new Date() }).where(eq(workflows.id, w.id)));
    const reading = withSpace({ spaceIds: [A], userId: null }, (tx) => workflowFacts(tx, A, [w.id]));
    expect(await lockWaiters(1, "%workflows%")).toBe(true);
    await archive.commit(async () => {});
    expect((await reading).get(w.id)?.archived).toBe(true);
  });
});
