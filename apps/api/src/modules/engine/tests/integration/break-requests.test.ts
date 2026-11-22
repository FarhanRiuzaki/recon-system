// Break requests through the approval workflow engine (DEC-052): force match, unmatch and write-off asked with a note
// by whoever works the break; the default chain (1 of reviewer or space admin) or the space's published workflow
// (levels, groups, any / all / N); one decision per person; a Superadmin only by override; one pending per break.
import { beforeEach, describe, expect, it } from "bun:test";
import type { BreakDetailDto } from "@starterkit/shared/contracts/breaks";
import type { ApprovalRowDto } from "@starterkit/shared/contracts/approvals";
import type { SpaceRole } from "@starterkit/shared/spaces";
import { eq } from "drizzle-orm";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { db } from "../../../../kernel/db";
import { ensureMonthPartitions } from "../../../../kernel/partitions";
import { activity } from "../../../audit";
import { records } from "../../../ingest";
import { spaceMembers, spaces } from "../../../spaces";
import { users } from "../../../users";
import { approvalRequests } from "../../../approvals";
import { matchGroups, reconItems } from "../../schema";
import { D, makeSource, plainSource, put, recon, spec } from "../fixtures";

const idOf = async (username: string) => (await db.select({ id: users.id }).from(users).where(eq(users.username, username)))[0]!.id;
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const code = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;
const message = async (r: Response) => ((await r.json()) as { error: { message: string } }).error.message;

let A: string, cfg: string;
let t: Record<"op" | "op2" | "rev" | "sa" | "adm", string>;
/** Items of the recon: a1 (A, 100.00, a break), b1 (B, 100.00, open), b2 (B, 99.00, a break), b3 (B, 100.00, open, EUR). */
let I: Record<"a1" | "b1" | "b2" | "b3", string>;

beforeEach(async () => {
  await resetData();
  await db.delete(spaces);
  A = Bun.randomUUIDv7();
  await db.insert(spaces).values({ id: A, code: "treasury", name: "Treasury" });
  const grant = async (username: string, role: SpaceRole) => db.insert(spaceMembers).values({ spaceId: A, userId: await idOf(username), role });
  await grant("viewer", "operator");
  await grant("apple", "operator");
  await grant("google", "reviewer");
  await db.transaction(async (tx) => {
    await ensureMonthPartitions(tx, records, new Date(`${D}T00:00:00Z`), 1);
    await ensureMonthPartitions(tx, reconItems, new Date(`${D}T00:00:00Z`), 1);
  });
  const [sa, sb] = [await makeSource(A, plainSource()), await makeSource(A, plainSource())];
  const [ra] = await put(sa, [{ ref: "P1", amount: 10_000n }]);
  const [rb1, rb2, rb3] = await put(sb, [{ ref: "P1", amount: 10_000n }, { ref: "P2", amount: 9_900n }, { ref: "P3", amount: 10_000n, ccy: "EUR" }]);
  const r = await recon(A, spec(sa.sourceId, sb.sourceId, [{ no: 1, name: "Exact", cardinality: "1:1", blocking: ["ext_ref"], accept: "auto", on_ambiguous: "break", predicates: [{ op: "eq", field: "amount_minor" }] }]));
  cfg = r.configId;
  const item = (side: "a" | "b", recordId: string, status: string, reason: string | null) =>
    ({ id: Bun.randomUUIDv7(), spaceId: A, configId: cfg, recordId, side, status, businessDate: D, breakReason: reason });
  const rows = { a1: item("a", ra!, "break", "No counterpart"), b1: item("b", rb1!, "open", null), b2: item("b", rb2!, "break", "No counterpart"), b3: item("b", rb3!, "open", null) };
  await db.insert(reconItems).values(Object.values(rows));
  I = { a1: rows.a1.id, b1: rows.b1.id, b2: rows.b2.id, b3: rows.b3.id };
  await db.delete(activity);
  await grant("admin", "space_admin");
  t = { op: await signIn("viewer"), op2: await signIn("apple"), rev: await signIn("google"), sa: await signIn("superadmin"), adm: await signIn("admin") };
  // the operator has the break
  await call("POST", `/v1/spaces/${A}/breaks/take`, { token: t.op, body: { ids: [I.a1] } });
});

const path = (id: string, what = "") => `/v1/spaces/${A}/breaks/${id}${what}`;


const req = (id: string, b: unknown, token = t.op) => call("POST", path(id, "/request"), { token, body: b });
const detail = (id: string, token = t.op) => json<BreakDetailDto>(call("GET", path(id), { token }));
/** A decision on the break's request (POST …/approval-requests/{id}/{how}). */
const decide = async (id: string, how: "approve" | "reject" | "override" | "cancel", b: unknown, token = t.rev) =>
  call("POST", `/v1/spaces/${A}/approval-requests/${(await detail(id, token)).request!.id}/${how}`, { token, body: b });
const state = async (id: string) => (await db.select({ s: reconItems.status, st: reconItems.breakState, r: reconItems.resolution }).from(reconItems).where(eq(reconItems.id, id)))[0]!;
/** Publish `spec` as the space's workflow for `action` (made by the admin, published by the Superadmin). */
async function publish(action: string, rules: unknown[]) {
  expect((await call("POST", `/v1/spaces/${A}/workflows/${action}/draft`, { token: t.adm })).status).toBe(200);
  expect((await call("PATCH", `/v1/spaces/${A}/workflows/${action}/draft`, { token: t.adm, body: { spec: { rules } } })).status).toBe(200);
  expect((await call("POST", `/v1/spaces/${A}/workflows/${action}/draft/submit`, { token: t.adm })).status).toBe(200);
  expect((await call("POST", `/v1/spaces/${A}/workflows/${action}/review/approve`, { token: t.sa, body: {} })).status).toBe(200);
}
const group = (o: object) => ({ spaceRoles: [], globalRoles: [], users: [], need: { kind: "any" }, ...o });

describe("the default chain (no workflow): one of reviewer or space admin", () => {
  it("a force match: only for totals that differ; pending holds the break; approved by a reviewer, by them, FORCE_MATCHED", async () => {
    const agree = await req(I.a1, { kind: "force_match", itemIds: [I.b1], note: "x" });
    expect([agree.status, await message(agree)]).toEqual([409, "These totals agree: match them without approval."]);
    expect((await req(I.a1, { kind: "force_match", itemIds: [I.b2], note: " " })).status).toBe(400);
    const d = await json<BreakDetailDto>(req(I.a1, { kind: "force_match", itemIds: [I.b2], note: "Fee taken by the switch" }));
    expect(d).toMatchObject({ state: "pending_approval", request: { kind: "force_match", status: "pending", ruleName: "Default", items: [{ ref: "P2" }], blocked: "You asked for this. Someone else in the chain decides it.", canCancel: true } });
    expect(d.request!.levels).toHaveLength(1);
    expect(d.request!.levels[0]!.groups[0]!.approvers.map((p) => p.name).sort()).toEqual(["Admin User", "Google User"]);
    expect(await code(await req(I.a1, { kind: "write_off", note: "x" }))).toBe("invalid_state");
    expect(await message(await call("POST", path(I.a1, "/close"), { token: t.op, body: { resolution: "NO_ACTION", note: "x" } }))).toBe("A change of this break waits for a checker's decision.");
    // an operator isn't in the chain; the reviewer's inbox lists it at level 1 of 1
    const no = await decide(I.a1, "approve", {}, t.op2);
    expect([no.status, await message(no)]).toEqual([403, "Level 1 (Checker) waits for 1 of Reviewer, Space admin."]);
    const inbox = await json<{ items: ApprovalRowDto[] }>(call("GET", `/v1/spaces/${A}/approvals?mine=1`, { token: t.rev }));
    expect(inbox.items).toMatchObject([{ kind: "force_match", target: { id: I.a1, code: "P1" }, version: null, blocked: null, level: { at: 1, of: 1 } }]);
    expect((await json<{ items: ApprovalRowDto[] }>(call("GET", `/v1/spaces/${A}/approvals?mine=1`, { token: t.op }))).items).toEqual([]);
    const kinds = async (k: string[]) => (await json<{ items: ApprovalRowDto[] }>(call("GET", `/v1/spaces/${A}/approvals?${k.map((x) => `kind=${x}`).join("&")}`, { token: t.rev }))).items.length;
    expect([await kinds(["recon_version", "force_match"]), await kinds(["recon_version", "write_off"])]).toEqual([1, 0]);
    expect(await json(decide(I.a1, "approve", { note: "Checked the fee schedule" }))).toEqual({ status: "approved" });
    const done = await detail(I.a1);
    expect(done).toMatchObject({ state: "resolved", resolution: "FORCE_MATCHED", matchedWith: [{ ref: "P2" }], request: { status: "approved", levels: [{ state: "done" }] } });
    expect(await state(I.b2)).toEqual({ s: "matched", st: "resolved", r: "FORCE_MATCHED" });
    const [r] = await db.select().from(approvalRequests);
    expect(r).toMatchObject({ status: "approved", decidedBy: await idOf("google"), decisionNote: "Checked the fee schedule" });
    const trail = await json<{ items: { action: string }[] }>(call("GET", path(I.a1, "/activity"), { token: t.op }));
    expect(trail.items.map((x) => x.action)).toEqual(["break.approve", "break.request", "break.take"]);
  });

  it("the one who asked can't decide (self_approval); a Superadmin only by override, with a reason, never their own", async () => {
    await call("POST", `/v1/spaces/${A}/breaks/assign`, { token: t.rev, body: { ids: [I.a1], assigneeId: await idOf("google") } });
    await req(I.a1, { kind: "write_off", note: "Below the bank's threshold" }, t.rev);
    const self = await decide(I.a1, "approve", {});
    expect([self.status, await code(self)]).toEqual([409, "self_approval"]);
    const sa = await decide(I.a1, "approve", {}, t.sa); // the Superadmin isn't in the chain
    expect(sa.status).toBe(403);
    expect((await detail(I.a1, t.sa)).request).toMatchObject({ canOverride: true });
    expect((await decide(I.a1, "override", { reason: "" }, t.sa)).status).toBe(400);
    expect(await json(decide(I.a1, "override", { reason: "Month-end, the head is away" }, t.sa))).toEqual({ status: "approved" });
    expect(await detail(I.a1)).toMatchObject({ state: "resolved", resolution: "WRITTEN_OFF", item: { status: "closed" }, request: { override: { reason: "Month-end, the head is away" } } });
  });

  it("rejected with a note, or cancelled by whoever asked: the break goes back to the state it had", async () => {
    await call("POST", `/v1/spaces/${A}/breaks/state`, { token: t.op, body: { ids: [I.a1], state: "investigating" } });
    await req(I.a1, { kind: "write_off", note: "Old item" });
    expect((await decide(I.a1, "reject", { note: "" })).status).toBe(400);
    expect(await json(decide(I.a1, "reject", { note: "Find the counterpart first" }))).toEqual({ status: "rejected" });
    expect(await detail(I.a1)).toMatchObject({ state: "investigating", request: { status: "rejected", rejection: { note: "Find the counterpart first" } } });
    await req(I.a1, { kind: "write_off", note: "Again" });
    expect((await decide(I.a1, "cancel", {}, t.rev)).status).toBe(403); // only whoever asked
    expect(await json(decide(I.a1, "cancel", {}, t.op))).toEqual({ status: "cancelled" });
    expect((await state(I.a1)).st).toBe("investigating");
  });

  it("unmatch: the match reversed by whoever approved; breaks back in the queue, an item that never broke open again", async () => {
    await call("POST", path(I.a1, "/match"), { token: t.op, body: { itemIds: [I.b1] } });
    expect(await code(await req(I.b2, { kind: "unmatch", note: "x" }, t.rev))).toBe("invalid_state");
    await req(I.a1, { kind: "unmatch", note: "Wrong transfer" });
    expect(await state(I.a1)).toMatchObject({ s: "matched", st: "resolved" });
    await decide(I.a1, "approve", {});
    expect(await detail(I.a1)).toMatchObject({ state: "assigned", resolution: null, matchedWith: [] });
    expect(await state(I.b1)).toEqual({ s: "open", st: null, r: null });
    const [g] = await db.select().from(matchGroups).where(eq(matchGroups.configId, cfg));
    expect(g).toMatchObject({ reverseReason: "unmatch", reversedBy: await idOf("google") });
  });
});

describe("a published workflow: rules by amount, levels in order, groups AND'd, one decision per person", () => {
  it("a write-off over 50.00 takes 2 levels (a reviewer, then a space admin); under it the plain rule", async () => {
    await publish("write_off", [
      { name: "Large", when: [{ attr: "amount", op: "gte", value: "5000" }], levels: [{ name: "Review", groups: [group({ spaceRoles: ["reviewer"] })] }, { name: "Head", groups: [group({ spaceRoles: ["space_admin"] })] }] },
      { name: "Small", when: [], levels: [{ name: "Any lead", groups: [group({ spaceRoles: ["reviewer", "space_admin"] })] }] },
    ]);
    await req(I.a1, { kind: "write_off", note: "Stale" }); // 100.00
    let d = await detail(I.a1, t.adm);
    expect(d.request).toMatchObject({ ruleName: "Large", currentLevel: 0, levels: [{ name: "Review", state: "waiting" }, { name: "Head", state: "next" }] });
    expect(d.request!.blocked).toBe("Level 1 (Review) waits for 1 of Reviewer."); // the admin is level 2
    expect(await json(decide(I.a1, "approve", {}))).toEqual({ status: "pending" });
    expect((await state(I.a1)).st).toBe("pending_approval"); // nothing happens until the last level
    d = await detail(I.a1, t.adm);
    expect(d.request).toMatchObject({ currentLevel: 1, blocked: null, levels: [{ state: "done" }, { state: "waiting" }] });
    expect(await json(decide(I.a1, "approve", {}, t.adm))).toEqual({ status: "approved" });
    expect(await state(I.a1)).toMatchObject({ s: "closed", r: "WRITTEN_OFF" });
  });

  it("one person decides one level; a level nobody else could pass is refused when asked", async () => {
    // all of the reviewers, but the only reviewer asks: refused with the level named
    await publish("force_match", [{ name: "Only", when: [], levels: [{ name: "Reviewers", groups: [group({ spaceRoles: ["reviewer"], need: { kind: "all" } })] }] }]);
    await call("POST", `/v1/spaces/${A}/breaks/assign`, { token: t.rev, body: { ids: [I.b2], assigneeId: await idOf("google") } });
    const r = await req(I.b2, { kind: "force_match", itemIds: [I.a1], note: "x" }, t.rev);
    expect(await message(r)).toBe("Level 1 (Reviewers) of the Force match workflow has nobody else who can approve it. Ask a space admin to fix the workflow.");
    // the reviewer is in both levels: after level 1 they can't decide level 2, which then needs the admin
    await publish("write_off", [{ name: "Two", when: [], levels: [{ name: "A", groups: [group({ spaceRoles: ["reviewer", "space_admin"] })] }, { name: "B", groups: [group({ spaceRoles: ["reviewer", "space_admin"] })] }] }]);
    await req(I.a1, { kind: "write_off", note: "x" });
    await decide(I.a1, "approve", {});
    expect(await message(await decide(I.a1, "approve", {}))).toBe("You decided this request already. Each person decides one level.");
    expect(await json(decide(I.a1, "approve", {}, t.adm))).toEqual({ status: "approved" });
  });
});
