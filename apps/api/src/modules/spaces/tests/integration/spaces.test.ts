// /v1/spaces*: the per-space guard ({ space, or }), check order, membership, the last space_admin, activity entries.
import { beforeEach, describe, expect, it } from "bun:test";
import type { Page } from "@starterkit/shared/contracts/common";
import type { SpaceMemberDto, SpaceRowDto } from "@starterkit/shared/contracts/spaces";
import { SPACE_ROLES, type SpaceRole } from "@starterkit/shared/spaces";
import { and, asc, eq } from "drizzle-orm";
import { api, call, request, resetData, signIn } from "../../../../../test/helpers/app";
import { holdTx, lockWaiters } from "../../../../../test/helpers/db";
import { db } from "../../../../kernel/db";
import { xactLock } from "../../../../kernel/locks";
import { activity } from "../../../audit";
import { guard } from "../../../auth";
import { users } from "../../../users";
import { spaceMembers, spaces } from "../../schema";

const code = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;
const idOf = async (username: string) => (await db.select({ id: users.id }).from(users).where(eq(users.username, username)))[0]!.id;
const rolesIn = async (spaceId: string, userId: string) =>
  (await db.select({ role: spaceMembers.role }).from(spaceMembers).where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)))).map((r) => r.role).sort();
const admins = async (spaceId: string) => db.$count(spaceMembers, and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.role, "space_admin")));
const acts = () => db.select({ action: activity.action, targetType: activity.targetType, targetId: activity.targetId, before: activity.before, after: activity.after })
  .from(activity).orderBy(asc(activity.at), asc(activity.id));

let A: string, B: string, sa: string;
const space = async (code: string, name: string) => {
  const id = Bun.randomUUIDv7();
  await db.insert(spaces).values({ id, code, name });
  return id;
};
const member = (spaceId: string, userId: string, ...roles: SpaceRole[]) => db.insert(spaceMembers).values(roles.map((role) => ({ spaceId, userId, role })));

beforeEach(async () => {
  await resetData();
  await db.delete(activity);
  A = await space("treasury", "Treasury");
  B = await space("ctop", "CTOP");
  sa = await signIn("superadmin");
});

const get = (path: string, token?: string) => call("GET", path, { token });
const put = (s: string, u: string, body: unknown, token: string) => call("PUT", `/v1/spaces/${s}/members/${u}`, { token, body });
const del = (s: string, u: string, token: string) => call("DELETE", `/v1/spaces/${s}/members/${u}`, { token });
const listCodes = async (token: string) => ((await (await get("/v1/spaces", token)).json()) as Page<SpaceRowDto>).items.map((s) => [s.code, s.roles]);

describe("GET /v1/spaces", () => {
  it("a member lists only their spaces; space.view lists all", async () => {
    await member(A, await idOf("viewer"), "viewer", "operator");
    expect(await listCodes(await signIn("viewer"))).toEqual([["treasury", ["operator", "viewer"]]]);
    expect(await listCodes(await signIn("google"))).toEqual([]);
    expect(await listCodes(sa)).toEqual([["ctop", []], ["treasury", []]]);
    expect((await get("/v1/spaces")).status).toBe(401);
  });

  it.each([["sort=code"], ["pageSize=10"], ["page=1001"]])("rejects %s with 400 before the guard", async (qs) => {
    expect((await get(`/v1/spaces?${qs}`)).status).toBe(400);
    expect((await get(`/v1/spaces/${A}/members?${qs}`)).status).toBe(400);
  });

  it("q matches code or name; sort -name", async () => {
    const page = async (qs: string) => ((await (await get(`/v1/spaces?${qs}`, sa)).json()) as Page<SpaceRowDto>).items.map((s) => s.code);
    expect(await page("q=TREAS")).toEqual(["treasury"]);
    expect(await page("sort=-name")).toEqual(["treasury", "ctop"]);
  });
});

describe("POST /v1/spaces and PATCH /v1/spaces/:spaceId", () => {
  it("POST /v1/spaces without space.manage is 403 before the body is read", async () => {
    const viewer = await signIn("viewer");
    const r = await call("POST", "/v1/spaces", { token: viewer, body: "{oops" });
    expect([r.status, await code(r)]).toEqual([403, "forbidden"]);
    expect((await call("POST", "/v1/spaces", { body: { code: "fico", name: "FICO" } })).status).toBe(401);
    expect(await db.$count(spaces)).toBe(2);
  });

  it("creates with 201 and an entry; a bad body is 400; a duplicate code in any case is 409", async () => {
    const r = await call("POST", "/v1/spaces", { token: sa, body: { code: "fico", name: "FICO" } });
    expect(r.status).toBe(201);
    const s = (await r.json()) as { id: string; code: string; status: string };
    expect(s).toMatchObject({ code: "fico", status: "active" });
    for (const body of [{ code: "f", name: "x" }, { code: "has space", name: "x" }, { code: "ok", name: "" }, { code: "x".repeat(33), name: "x" }]) {
      expect((await call("POST", "/v1/spaces", { token: sa, body })).status).toBe(400);
    }
    const dup = await call("POST", "/v1/spaces", { token: sa, body: { code: "TREASURY", name: "Other" } });
    expect([dup.status, await code(dup)]).toEqual([409, "duplicate"]);
    expect(await acts()).toEqual([{ action: "space.create", targetType: "space", targetId: s.id, before: null, after: expect.objectContaining({ code: "fico" }) }]);
  });

  it("PATCH: space_admin or space.manage; changed fields only in the entry; nothing to change = no entry", async () => {
    const viewer = await idOf("viewer");
    await member(A, viewer, "viewer");
    const t = await signIn("viewer");
    expect((await call("PATCH", `/v1/spaces/${A}`, { token: t, body: { name: "X" } })).status).toBe(403);
    await member(A, viewer, "space_admin");
    const r = await call("PATCH", `/v1/spaces/${A}`, { token: t, body: { name: "Treasury Ops", status: "active" } });
    expect(r.status).toBe(200);
    expect(await call("PATCH", `/v1/spaces/${A}`, { token: sa, body: { name: "Treasury Ops" } }).then((x) => x.status)).toBe(200);
    expect((await call("PATCH", `/v1/spaces/${A}`, { token: sa, body: { color: "red" } })).status).toBe(400);
    expect((await call("PATCH", `/v1/spaces/${Bun.randomUUIDv7()}`, { token: sa, body: { name: "X" } })).status).toBe(404);
    expect(await acts()).toEqual([{ action: "space.update", targetType: "space", targetId: A, before: { name: "Treasury" }, after: { name: "Treasury Ops" } }]);
  });
});

describe("members", () => {
  it("a viewer of space A gets 403 on PUT member in space A; a space_admin gets 200 and an activity entry space.member_set", async () => {
    const [viewer, google, apple] = [await idOf("viewer"), await idOf("google"), await idOf("apple")];
    await member(A, viewer, "viewer");
    await member(A, google, "space_admin");
    const r403 = await put(A, apple, { roles: ["operator"] }, await signIn("viewer"));
    expect([r403.status, await code(r403)]).toEqual([403, "forbidden"]);
    expect(await rolesIn(A, apple)).toEqual([]);

    const g = await signIn("google");
    const r = await put(A, apple, { roles: ["operator", "viewer"] }, g);
    expect(r.status).toBe(200);
    expect((await r.json()) as SpaceMemberDto).toMatchObject({ userId: apple, roles: ["operator", "viewer"] });
    expect((await put(A, apple, { roles: ["reviewer"] }, g)).status).toBe(200); // replaces the set
    expect(await rolesIn(A, apple)).toEqual(["reviewer"]);
    expect((await put(A, apple, { roles: ["reviewer"] }, g)).status).toBe(200); // same set: no entry
    expect(await acts()).toEqual([
      { action: "space.member_set", targetType: "space", targetId: A, before: { user: { id: apple, name: "Apple User" }, roles: [] }, after: { user: { id: apple, name: "Apple User" }, roles: ["operator", "viewer"] } },
      { action: "space.member_set", targetType: "space", targetId: A, before: { user: { id: apple, name: "Apple User" }, roles: ["operator", "viewer"] }, after: { user: { id: apple, name: "Apple User" }, roles: ["reviewer"] } },
    ]);
    // a space_admin of A is nobody in B
    expect((await put(B, apple, { roles: ["viewer"] }, g)).status).toBe(403);
  });

  it("the body is 400 after the guard and before the 404: empty, repeated, unknown or more than 7 roles", async () => {
    const apple = await idOf("apple");
    expect((await put(A, apple, { roles: ["what"] }, await signIn("viewer"))).status).toBe(403);
    for (const roles of [[], ["viewer", "viewer"], ["admin"], [...SPACE_ROLES, "viewer"]]) expect((await put(A, apple, { roles }, sa)).status).toBe(400);
    expect((await put(A, Bun.randomUUIDv7(), { roles: ["viewer"] }, sa)).status).toBe(404);
    expect((await put(A, "nope", { roles: ["viewer"] }, sa)).status).toBe(404);
    expect((await put(Bun.randomUUIDv7(), apple, { roles: ["viewer"] }, sa)).status).toBe(404); // space.manage, no such space
    expect((await put(A, apple, { roles: [...SPACE_ROLES] }, sa)).status).toBe(200);
  });

  it("GET members: any role in the space or space.manage; paged with each user's roles", async () => {
    const [viewer, apple] = [await idOf("viewer"), await idOf("apple")];
    await member(A, viewer, "viewer");
    await member(A, apple, "operator", "space_admin");
    const page = (await (await get(`/v1/spaces/${A}/members`, await signIn("viewer"))).json()) as Page<SpaceMemberDto>;
    expect(page.items.map((m) => [m.name, m.roles])).toEqual([["Apple User", ["space_admin", "operator"]], ["Viewer User", ["viewer"]]]);
    expect(page.total).toBe(2);
    expect((await get(`/v1/spaces/${B}/members`, await signIn("viewer"))).status).toBe(403);
    expect((await get(`/v1/spaces/${B}/members`, sa)).status).toBe(200);
    expect((await get(`/v1/spaces/${Bun.randomUUIDv7()}/members`, sa)).status).toBe(404);
  });

  it("a user removed from space A gets 403 on the next request to /v1/spaces/A/members", async () => {
    const viewer = await idOf("viewer");
    await member(A, viewer, "viewer");
    const t = await signIn("viewer");
    expect((await get(`/v1/spaces/${A}/members`, t)).status).toBe(200);
    const r = await del(A, viewer, sa);
    expect(r.status).toBe(200);
    expect((await get(`/v1/spaces/${A}/members`, t)).status).toBe(403);
    expect(await acts()).toEqual([{ action: "space.member_remove", targetType: "space", targetId: A, before: { user: { id: viewer, name: "Viewer User" }, roles: ["viewer"] }, after: null }]);
    expect((await del(A, viewer, sa)).status).toBe(404); // no longer a member
  });

  it("a non-UUID spaceId is 404 without a query", async () => {
    // a uuid comparison with "abc" would fail in PostgreSQL (500); 404 for a signed-in non-member means no lookup ran
    const t = await signIn("viewer");
    for (const r of [await get("/v1/spaces/abc/members", t), await put("abc", await idOf("apple"), { roles: ["viewer"] }, t), await del("1", await idOf("apple"), t)]) {
      expect([r.status, await code(r)]).toEqual([404, "not_found"]);
    }
    expect((await get("/v1/spaces/abc/members")).status).toBe(401);
  });

  it("removing the last space_admin is 409 last_space_admin; two concurrent removals of the last two admins leave one", async () => {
    const [viewer, google] = [await idOf("viewer"), await idOf("google")];
    await member(A, viewer, "space_admin", "operator");
    const r = await del(A, viewer, sa);
    expect([r.status, await code(r)]).toEqual([409, "last_space_admin"]);
    const r2 = await put(A, viewer, { roles: ["operator"] }, sa); // dropping the role is a removal too
    expect([r2.status, await code(r2)]).toEqual([409, "last_space_admin"]);
    expect(await rolesIn(A, viewer)).toEqual(["operator", "space_admin"]);

    // two space.manage holders remove the last two admins at once: a held lock lets both pass the guard first
    await member(A, google, "space_admin");
    const holder = await holdTx((tx) => xactLock(tx, "spaceAdmins"));
    let rs: Response[];
    let waited = false;
    try {
      const both = Promise.all([del(A, viewer, sa), del(A, google, await signIn("admin"))]);
      waited = await lockWaiters(2, "%pg_advisory_xact_lock%");
      await holder.commit();
      rs = await both;
    } finally {
      await holder.rollback();
    }
    expect(waited).toBe(true);
    expect(rs.map((x) => x.status).sort()).toEqual([200, 409]);
    expect(await admins(A)).toBe(1);
    expect(await code(rs.find((x) => x.status === 409)!)).toBe("last_space_admin");
  });

  it("two space_admins removing each other at once: the second actor is no longer an admin (403), one stays", async () => {
    const [viewer, google] = [await idOf("viewer"), await idOf("google")];
    await member(A, viewer, "space_admin");
    await member(A, google, "space_admin");
    const [tv, tg] = [await signIn("viewer"), await signIn("google")];
    const holder = await holdTx((tx) => xactLock(tx, "spaceAdmins"));
    let rs: Response[];
    try {
      const both = Promise.all([del(A, google, tv), del(A, viewer, tg)]);
      await lockWaiters(2, "%pg_advisory_xact_lock%");
      await holder.commit();
      rs = await both;
    } finally {
      await holder.rollback();
    }
    expect(rs.map((x) => x.status).sort()).toEqual([200, 403]);
    expect(await admins(A)).toBe(1);
  });

  it("only space.manage grants or removes source_admin: a space_admin gets 403 with nothing changed", async () => {
    const [viewer, google, apple] = [await idOf("viewer"), await idOf("google"), await idOf("apple")];
    await member(A, google, "space_admin");
    await member(A, viewer, "source_admin", "viewer");
    await member(A, apple, "source_admin");
    const g = await signIn("google");
    const forbidden = async (r: Response) => [r.status, await code(r)];
    const fresh = await idOf("admin"); // no role in A

    expect(await forbidden(await put(A, fresh, { roles: ["source_admin"] }, g))).toEqual([403, "forbidden"]); // grant
    expect(await rolesIn(A, fresh)).toEqual([]);
    expect(await forbidden(await put(A, viewer, { roles: ["viewer"] }, g))).toEqual([403, "forbidden"]); // revoke
    expect(await rolesIn(A, viewer)).toEqual(["source_admin", "viewer"]);
    expect(await forbidden(await del(A, apple, g))).toEqual([403, "forbidden"]); // removal takes source_admin too
    expect(await rolesIn(A, apple)).toEqual(["source_admin"]);
    expect(await acts()).toEqual([]);
    expect((await put(A, apple, { roles: ["source_admin", "viewer"] }, g)).status).toBe(200); // source_admin kept

    // the same three with space.manage
    expect((await put(A, fresh, { roles: ["source_admin"] }, sa)).status).toBe(200);
    expect((await put(A, viewer, { roles: ["viewer"] }, sa)).status).toBe(200);
    expect((await del(A, apple, sa)).status).toBe(200);
    expect([await rolesIn(A, fresh), await rolesIn(A, viewer), await rolesIn(A, apple)]).toEqual([["source_admin"], ["viewer"], []]);
  });

  it("space.manage without membership can manage members but GET /v1/spaces lists the space without data access", async () => {
    const apple = await idOf("apple");
    expect((await put(A, apple, { roles: ["space_admin"] }, sa)).status).toBe(200);
    expect(await listCodes(sa)).toEqual([["ctop", []], ["treasury", []]]); // listed, no role in either
    // a space route that doesn't name `or` (every data route of Plan 2+) is 403 for a platform admin without a role
    const state = { ran: false, ctx: null as unknown };
    const app = api().use(guard).get("/v1/spaces/:spaceId/data", ({ ctx }) => {
      state.ran = true;
      state.ctx = ctx;
      return { ok: true };
    }, { guard: { space: SPACE_ROLES } });
    const go = (token: string) => request(app, `/v1/spaces/${A}/data`, { headers: { "X-Internal-Token": process.env.INTERNAL_API_TOKEN!, Authorization: `Bearer ${token}` } });
    const r = await go(sa);
    expect([r.status, await code(r)]).toEqual([403, "forbidden"]);
    expect(state.ran).toBe(false);
    expect((await go(await signIn("apple"))).status).toBe(200);
    expect(state.ctx).toMatchObject({ user: { id: apple }, space: { id: A, roles: ["space_admin"] } });
  });
});

