// A space's approval workflows (DEC-052): a space admin (or a workflow.manage holder) drafts, autosaves and sends a
// version; another one publishes it (a Superadmin their own only by override, with a reason); "Who approves" shows the
// chain sample attributes take and who could approve it.
import { beforeEach, describe, expect, it } from "bun:test";
import type { PreviewDto, WorkflowDetailDto, WorkflowListDto } from "@starterkit/shared/contracts/workflows";
import type { SpaceRole } from "@starterkit/shared/spaces";
import { eq } from "drizzle-orm";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { db } from "../../../../kernel/db";
import { spaceMembers, spaces } from "../../../spaces";
import { users } from "../../../users";

const idOf = async (u: string) => (await db.select({ id: users.id }).from(users).where(eq(users.username, u)))[0]!.id;
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const err = async (r: Response) => ((await r.json()) as { error: { code: string; message: string } }).error;
let A: string;
let t: Record<"adm" | "rev" | "op" | "sa", string>;
const W = (what = "") => `/v1/spaces/${A}/workflows/write_off${what}`;
const RULES = [{ name: "Large", when: [{ attr: "amount", op: "gte", value: "1000000" }], levels: [
  { name: "Review", groups: [{ spaceRoles: ["reviewer"], globalRoles: [], users: [], need: { kind: "any" } }] },
  { name: "Head", groups: [{ spaceRoles: ["space_admin"], globalRoles: [], users: [], need: { kind: "count", n: 2 } }] },
] }];

beforeEach(async () => {
  await resetData();
  await db.delete(spaces);
  A = Bun.randomUUIDv7();
  await db.insert(spaces).values({ id: A, code: "treasury", name: "Treasury" });
  const grant = async (u: string, role: SpaceRole) => db.insert(spaceMembers).values({ spaceId: A, userId: await idOf(u), role });
  await grant("admin", "space_admin");
  await grant("google", "reviewer");
  await grant("viewer", "operator");
  t = { adm: await signIn("admin"), rev: await signIn("google"), op: await signIn("viewer"), sa: await signIn("superadmin") };
});

describe("editing and publishing a workflow", () => {
  it("lists every action; only an editor drafts; a draft autosaves; nobody publishes their own; another editor does", async () => {
    const list = await json<WorkflowListDto>(call("GET", `/v1/spaces/${A}/workflows`, { token: t.op }));
    expect(list.items.map((x) => [x.action, x.published, x.open])).toEqual([["force_match", null, null], ["unmatch", null, null], ["write_off", null, null]]);
    expect((await call("GET", `/v1/spaces/${A}/workflows/nope`, { token: t.op })).status).toBe(404);
    expect((await call("POST", W("/draft"), { token: t.op })).status).toBe(403);
    expect((await json<WorkflowDetailDto>(call("POST", W("/draft"), { token: t.adm }))).open).toMatchObject({ version: 1, status: "draft", spec: { rules: [] } });
    const bad = await call("PATCH", W("/draft"), { token: t.adm, body: { spec: { rules: [{ name: "x", when: [], levels: [{ name: "", groups: [{ spaceRoles: [], globalRoles: [], users: [], need: { kind: "any" } }] }] }] } } });
    expect(bad.status).toBe(400); // a group names nobody
    expect((await json<WorkflowDetailDto>(call("PATCH", W("/draft"), { token: t.adm, body: { spec: { rules: RULES } } }))).open!.spec.rules).toHaveLength(1);
    expect((await call("POST", W("/draft/submit"), { token: t.adm })).status).toBe(200);
    expect((await call("PATCH", W("/draft"), { token: t.adm, body: { spec: { rules: [] } } })).status).toBe(409); // in review: frozen
    const own = await call("POST", W("/review/approve"), { token: t.adm, body: {} });
    expect((await err(own)).code).toBe("self_approval");
    // the Superadmin isn't its maker: publishes; the list says so
    const pub = await json<WorkflowDetailDto>(call("POST", W("/review/approve"), { token: t.sa, body: {} }));
    expect(pub).toMatchObject({ published: { version: 1, status: "published", decidedBy: { name: "Super Admin" } }, open: null });
    expect((await json<WorkflowListDto>(call("GET", `/v1/spaces/${A}/workflows`, { token: t.op }))).items[2]).toMatchObject({ published: { version: 1, rules: 1, levels: 2 } });
  });

  it("sent back with a comment; a Superadmin's own version only by override, with a reason", async () => {
    await call("POST", W("/draft"), { token: t.sa });
    await call("PATCH", W("/draft"), { token: t.sa, body: { spec: { rules: RULES } } });
    await call("POST", W("/draft/submit"), { token: t.sa });
    expect((await json<WorkflowDetailDto>(call("GET", W(), { token: t.sa }))).overrideOnly).toBe(true);
    expect((await err(await call("POST", W("/review/approve"), { token: t.sa, body: {} }))).code).toBe("self_approval");
    expect((await call("POST", W("/review/reject"), { token: t.adm, body: {} })).status).toBe(400);
    expect((await json<WorkflowDetailDto>(call("POST", W("/review/reject"), { token: t.adm, body: { comment: "Two heads is too many" } }))).open).toMatchObject({ status: "draft", reviewComment: "Two heads is too many" });
    await call("POST", W("/draft/submit"), { token: t.sa });
    const o = await json<WorkflowDetailDto>(call("POST", W("/review/approve"), { token: t.sa, body: { override: true, comment: "Audit asked for it today" } }));
    expect(o.published).toMatchObject({ overrideReason: "Audit asked for it today" });
  });
});

describe("Who approves", () => {
  it("the rule sample attributes take, each group's approvers now, and short when there aren't enough", async () => {
    const big = await json<PreviewDto>(call("POST", W("/preview"), { token: t.op, body: { spec: { rules: RULES }, attributes: { amount: "2500000" } } }));
    expect(big.rule).toEqual({ name: "Large", index: 0 });
    expect(big.levels.map((l) => l.groups.map((g) => [g.approvers.map((p) => p.name), g.short]))).toEqual([[[["Google User"], false]], [[["Admin User"], true]]]);
    const small = await json<PreviewDto>(call("POST", W("/preview"), { token: t.op, body: { spec: { rules: RULES }, attributes: { amount: "10" } } }));
    expect(small.rule).toEqual({ name: "Default", index: null }); // no rule matches: the default chain
  });
});
