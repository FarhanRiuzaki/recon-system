// A space's approval rules (DEC-052 revision §4.3): a space admin (or a workflow.manage holder) drafts, autosaves and
// sends a version whose rules pick library workflows; another one publishes it (a Superadmin their own only by
// override, with a reason); "Who approves" shows the rule and workflow sample attributes take and who could approve it.
import { beforeEach, describe, expect, it } from "bun:test";
import type { PreviewDto, RulesDetailDto, RulesListDto } from "@starterkit/shared/contracts/workflows";
import type { SpaceRole } from "@starterkit/shared/spaces";
import type { Level } from "@starterkit/shared/workflows";
import { eq } from "drizzle-orm";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { db } from "../../../../kernel/db";
import { spaceMembers, spaces } from "../../../spaces";
import { users } from "../../../users";
import { workflows, workflowVersions } from "../../schema";

const idOf = async (u: string) => (await db.select({ id: users.id }).from(users).where(eq(users.username, u)))[0]!.id;
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const err = async (r: Response) => ((await r.json()) as { error: { code: string; message: string } }).error;
let A: string, W: string;
let t: Record<"adm" | "rev" | "op" | "sa", string>;
const R = (what = "") => `/v1/spaces/${A}/approval-rules/write_off${what}`;
const LEVELS: Level[] = [
  { name: "Review", groups: [{ spaceRoles: ["reviewer"], globalRoles: [], users: [], need: { kind: "any" } }] },
  { name: "Head", groups: [{ spaceRoles: ["space_admin"], globalRoles: [], users: [], need: { kind: "count", n: 2 } }] },
];
/** A library workflow with a live version 1 (or only a draft), straight into the tables. */
export async function libraryWorkflow(name: string, levels: Level[], status: "published" | "draft" = "published") {
  const id = Bun.randomUUIDv7();
  await db.insert(workflows).values({ id, name });
  await db.insert(workflowVersions).values({ id: Bun.randomUUIDv7(), workflowId: id, version: 1, status, spec: { name, levels } });
  return id;
}
const rules = (workflowId: string, otherwise: string | null = null) => ({ rules: [{ name: "Large", when: [{ attr: "amount", op: "gte", value: "1000000" }], workflowId }], otherwise });

beforeEach(async () => {
  await resetData();
  await db.delete(spaces);
  await db.delete(workflows);
  A = Bun.randomUUIDv7();
  await db.insert(spaces).values({ id: A, code: "treasury", name: "Treasury" });
  const grant = async (u: string, role: SpaceRole) => db.insert(spaceMembers).values({ spaceId: A, userId: await idOf(u), role });
  await grant("admin", "space_admin");
  await grant("google", "reviewer");
  await grant("viewer", "operator");
  t = { adm: await signIn("admin"), rev: await signIn("google"), op: await signIn("viewer"), sa: await signIn("superadmin") };
  W = await libraryWorkflow("Two step", LEVELS);
});

describe("editing and publishing approval rules", () => {
  it("lists every trigger; only an editor drafts; a draft autosaves; nobody publishes their own; another editor does", async () => {
    const list = await json<RulesListDto>(call("GET", `/v1/spaces/${A}/approval-rules`, { token: t.op }));
    expect(list.items.map((x) => [x.trigger, x.published, x.open])).toEqual([["force_match", null, null], ["unmatch", null, null], ["write_off", null, null]]);
    expect((await call("GET", `/v1/spaces/${A}/approval-rules/nope`, { token: t.op })).status).toBe(404);
    expect((await call("POST", R("/draft"), { token: t.op })).status).toBe(403);
    expect((await json<RulesDetailDto>(call("POST", R("/draft"), { token: t.adm }))).open).toMatchObject({ version: 1, status: "draft", spec: { rules: [], otherwise: null } });
    const bad = await call("PATCH", R("/draft"), { token: t.adm, body: { spec: { rules: [{ name: "x", when: [], workflowId: "nope" }], otherwise: null } } });
    expect(bad.status).toBe(400);
    expect((await json<RulesDetailDto>(call("PATCH", R("/draft"), { token: t.adm, body: { spec: rules(W) } }))).open!.spec.rules).toHaveLength(1);
    expect((await call("POST", R("/draft/submit"), { token: t.adm })).status).toBe(200);
    expect((await call("PATCH", R("/draft"), { token: t.adm, body: { spec: { rules: [], otherwise: null } } })).status).toBe(409); // in review: frozen
    expect((await err(await call("POST", R("/review/approve"), { token: t.adm, body: {} }))).code).toBe("self_approval");
    const pub = await json<RulesDetailDto>(call("POST", R("/review/approve"), { token: t.sa, body: {} }));
    expect(pub).toMatchObject({ published: { version: 1, status: "published", decidedBy: { name: "Super Admin" } }, open: null });
    expect((await json<RulesListDto>(call("GET", `/v1/spaces/${A}/approval-rules`, { token: t.op }))).items[2]).toMatchObject({ published: { version: 1, rules: 1, otherwise: null } });
  });

  it("sent back with a comment; a Superadmin's own version only by override, with a reason", async () => {
    await call("POST", R("/draft"), { token: t.sa });
    await call("PATCH", R("/draft"), { token: t.sa, body: { spec: rules(W) } });
    await call("POST", R("/draft/submit"), { token: t.sa });
    expect((await json<RulesDetailDto>(call("GET", R(), { token: t.sa }))).overrideOnly).toBe(true);
    expect((await err(await call("POST", R("/review/approve"), { token: t.sa, body: {} }))).code).toBe("self_approval");
    expect((await call("POST", R("/review/reject"), { token: t.adm, body: {} })).status).toBe(400);
    expect((await json<RulesDetailDto>(call("POST", R("/review/reject"), { token: t.adm, body: { comment: "Too strict" } }))).open).toMatchObject({ status: "draft", reviewComment: "Too strict" });
    await call("POST", R("/draft/submit"), { token: t.sa });
    const o = await json<RulesDetailDto>(call("POST", R("/review/approve"), { token: t.sa, body: { override: true, comment: "Audit asked for it today" } }));
    expect(o.published).toMatchObject({ overrideReason: "Audit asked for it today" });
  });

  it("rules pick only live workflows; a space admin sees the library without workflow.view", async () => {
    const draftOnly = await libraryWorkflow("Not yet", LEVELS, "draft");
    await call("POST", R("/draft"), { token: t.adm });
    const r = await call("PATCH", R("/draft"), { token: t.adm, body: { spec: rules(draftOnly) } });
    expect(r.status).toBe(400);
    expect((await err(r)).message).toContain("has no live version");
    const viewer = await signIn("viewer"); // operator, Viewer role: no workflow.view
    expect((await call("GET", "/v1/workflows", { token: viewer })).status).toBe(403);
    expect((await json<RulesDetailDto>(call("GET", R(), { token: t.adm }))).library.map((w) => w.name)).toEqual(["Two step"]);
  });
});

describe("Who approves", () => {
  it("the rule and workflow sample attributes take, each group's approvers now, and short when there aren't enough", async () => {
    const big = await json<PreviewDto>(call("POST", R("/preview"), { token: t.op, body: { spec: rules(W), attributes: { amount: "2500000" } } }));
    expect(big.rule).toEqual({ name: "Large", index: 0 });
    expect(big.workflow).toEqual({ id: W, name: "Two step" });
    expect(big.levels.map((l) => l.groups.map((g) => [g.approvers.map((p) => p.name), g.short]))).toEqual([[[["Google User"], false]], [[["Admin User"], true]]]);
    const small = await json<PreviewDto>(call("POST", R("/preview"), { token: t.op, body: { spec: rules(W), attributes: { amount: "10" } } }));
    expect(small.rule).toEqual({ name: "Otherwise", index: null });
    expect(small.workflow).toBeNull(); // otherwise null: the default chain
    expect(small.levels).toHaveLength(1);
  });
});
