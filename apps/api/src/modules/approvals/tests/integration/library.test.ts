// The global workflow library (DEC-052 revision §4.2): only workflow.manage holders create and edit; another one
// publishes (a Superadmin their own only by override); archive is refused while approval rules use it; Used by lists
// the rules across spaces and the levels that would lack people in each (approvers must be members of the space).
import { beforeEach, describe, expect, it } from "bun:test";
import type { Page } from "@starterkit/shared/contracts/common";
import type { LibraryDetailDto, LibraryRowDto, UsedByRowDto } from "@starterkit/shared/contracts/workflows";
import type { Level } from "@starterkit/shared/workflows";
import { and, eq } from "drizzle-orm";
import { call, platformAdmin, resetData, signIn } from "../../../../../test/helpers/app";
import { holdTx, lockWaiters } from "../../../../../test/helpers/db";
import { db } from "../../../../kernel/db";
import { activity } from "../../../audit";
import { spaceMembers, spaces } from "../../../spaces";
import { users } from "../../../users";
import { approvalBindings, workflows } from "../../schema";

const idOf = async (u: string) => (await db.select({ id: users.id }).from(users).where(eq(users.username, u)))[0]!.id;
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const err = async (r: Response) => ((await r.json()) as { error: { code: string; message: string } }).error;
const reviewers: Level[] = [{ name: "Checker", groups: [{ spaceRoles: ["reviewer"], globalRoles: [], users: [], need: { kind: "any" } }] }];
let A: string, B: string;
let t: Record<"m1" | "m2" | "sa" | "sadm", string>;

async function create(token: string, name: string, levels: Level[] = reviewers) {
  return json<LibraryDetailDto>(call("POST", "/v1/workflows", { token, body: { spec: { name, levels } } }));
}
async function publish(id: string, by: string, maker: string) {
  await call("POST", `/v1/workflows/${id}/draft/submit`, { token: maker });
  return call("POST", `/v1/workflows/${id}/review/approve`, { token: by, body: {} });
}
const rulesIn = (spaceId: string, workflowId: string) => db.insert(approvalBindings).values({
  id: Bun.randomUUIDv7(), spaceId, trigger: "write_off", version: 1, status: "published", spec: { rules: [{ name: "Large", when: [], workflowId }], otherwise: null },
});

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
  t = { m1: await signIn("admin"), m2: await platformAdmin(), sa: await signIn("superadmin"), sadm: await signIn("viewer") };
});

describe("the workflow library", () => {
  it("a manager creates, another publishes; a space admin without workflow.manage can't create or read it", async () => {
    const w = await create(t.m1, "Checker only");
    expect(w.open).toMatchObject({ version: 1, status: "draft", spec: { name: "Checker only" } });
    expect((await err(await publish(w.id, t.m1, t.m1))).code).toBe("self_approval");
    expect((await json<LibraryDetailDto>(call("POST", `/v1/workflows/${w.id}/review/approve`, { token: t.m2, body: {} }))).published).toMatchObject({ version: 1 });
    const list = await json<Page<LibraryRowDto>>(call("GET", "/v1/workflows", { token: t.m1 }));
    expect(list.items.map((r) => [r.name, r.published?.version, r.levels])).toEqual([["Checker only", 1, 1]]);
    expect((await call("POST", "/v1/workflows", { token: t.sadm, body: { spec: { name: "x", levels: reviewers } } })).status).toBe(403);
    expect((await call("GET", "/v1/workflows", { token: t.sadm })).status).toBe(403);
    const acts = await db.select({ action: activity.action }).from(activity).where(eq(activity.targetId, w.id));
    expect(acts.map((a) => a.action).sort()).toEqual(["workflow.create", "workflow.publish", "workflow.submit"]);
  });

  it("a Superadmin publishes their own only by override, with a reason", async () => {
    const w = await create(t.sa, "Mine");
    expect((await err(await publish(w.id, t.sa, t.sa))).code).toBe("self_approval");
    const o = await json<LibraryDetailDto>(call("POST", `/v1/workflows/${w.id}/review/approve`, { token: t.sa, body: { override: true, comment: "Month end" } }));
    expect(o.published).toMatchObject({ overrideReason: "Month end" });
  });

  it("one open draft at a time; names are unique", async () => {
    const w = await create(t.m1, "Checker only");
    expect((await err(await call("POST", `/v1/workflows/${w.id}/draft`, { token: t.m1 }))).code).toBe("invalid_state");
    const dup = await call("POST", "/v1/workflows", { token: t.m1, body: { spec: { name: "checker ONLY", levels: reviewers } } });
    expect((await err(dup)).code).toBe("duplicate");
  });

  it("archive is refused while approval rules use it, then allowed", async () => {
    const w = await create(t.m1, "Checker only");
    await publish(w.id, t.m2, t.m1);
    await rulesIn(A, w.id);
    const r = await call("POST", `/v1/workflows/${w.id}/archive`, { token: t.m1 });
    expect(r.status).toBe(409);
    expect((await err(r)).message).toContain("Treasury · Write-off");
    await db.update(approvalBindings).set({ status: "retired" }).where(and(eq(approvalBindings.spaceId, A)));
    expect((await json<LibraryDetailDto>(call("POST", `/v1/workflows/${w.id}/archive`, { token: t.m1 }))).archived).toBe(true);
  });

  it("only its maker edits a draft: another manager's save is refused, so nobody publishes what they wrote", async () => {
    const w = await create(t.m1, "Checker only");
    const r = await call("PATCH", `/v1/workflows/${w.id}/draft`, { token: t.m2, body: { spec: { name: "Checker only", levels: [...reviewers, ...reviewers] } } });
    expect((await err(r)).code).toBe("invalid_state");
    expect((await json<LibraryDetailDto>(call("GET", `/v1/workflows/${w.id}`, { token: t.m1 }))).open!.spec.levels).toHaveLength(1);
  });

  it("an archive in flight holds a rules publish that picks the workflow, which then refuses it", async () => {
    const w = await create(t.m1, "Checker only");
    await publish(w.id, t.m2, t.m1);
    const sa = await signIn("superadmin");
    await db.insert(spaceMembers).values({ spaceId: A, userId: await idOf("admin"), role: "space_admin" });
    const R = (x = "") => `/v1/spaces/${A}/approval-rules/write_off${x}`;
    await call("POST", R("/draft"), { token: t.m1 });
    await call("PATCH", R("/draft"), { token: t.m1, body: { spec: { rules: [{ name: "Large", when: [], workflowId: w.id }], otherwise: null } } });
    await call("POST", R("/draft/submit"), { token: t.m1 });
    const archive = await holdTx((tx) => tx.update(workflows).set({ archivedAt: new Date() }).where(eq(workflows.id, w.id)));
    const publishing = call("POST", R("/review/approve"), { token: sa, body: {} });
    expect(await lockWaiters(1, "%workflows%")).toBe(true); // waits for the archive
    await archive.commit(async () => {});
    const r = await publishing;
    expect(r.status).toBe(400);
    expect((await err(r)).message).toContain("has no live version");
  });

  it("used by lists each space's rules and the levels short of people there", async () => {
    const google = await idOf("google");
    const w = await create(t.m1, "Named", [{ name: "Head", groups: [{ spaceRoles: [], globalRoles: [], users: [google], need: { kind: "any" } }] }, ...reviewers]);
    await publish(w.id, t.m2, t.m1);
    await rulesIn(A, w.id);
    await rulesIn(B, w.id);
    const used = await json<Page<UsedByRowDto>>(call("GET", `/v1/workflows/${w.id}/used-by`, { token: t.m1 }));
    // google is a member of both; Payments has no reviewer
    expect(used.items.map((u) => [u.spaceName, u.trigger, u.ruleName, u.short])).toEqual([["Payments", "write_off", "Large", ["Level 2 (Checker)"]], ["Treasury", "write_off", "Large", []]]);
    await db.delete(spaceMembers).where(and(eq(spaceMembers.spaceId, B), eq(spaceMembers.userId, google)));
    const after = await json<Page<UsedByRowDto>>(call("GET", `/v1/workflows/${w.id}/used-by`, { token: t.m1 }));
    expect(after.items[0]!.short).toEqual(["Level 1 (Head)", "Level 2 (Checker)"]); // not a member: doesn't count
    expect((await json<Page<LibraryRowDto>>(call("GET", "/v1/workflows", { token: t.m1 }))).items[0]).toMatchObject({ rulesUsing: 2, spacesUsing: 2 });
  });
});
