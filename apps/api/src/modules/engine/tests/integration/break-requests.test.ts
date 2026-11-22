// Break requests through the approval workflow engine (DEC-052): force match, unmatch and write-off asked with a note
// by whoever works the break; the default chain (1 of reviewer or space admin) or the space's published workflow
// (levels, groups, any / all / N); one decision per person; a Superadmin only by override; one pending per break.
import { beforeEach, describe, expect, it } from "bun:test";
import type { BreakDetailDto } from "@starterkit/shared/contracts/breaks";
import type { ApprovalRowDto } from "@starterkit/shared/contracts/approvals";
import type { SpaceRole } from "@starterkit/shared/spaces";
import { and, eq } from "drizzle-orm";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { db } from "../../../../kernel/db";
import { ensureMonthPartitions } from "../../../../kernel/partitions";
import { activity } from "../../../audit";
import { records } from "../../../ingest";
import { spaceMembers, spaces } from "../../../spaces";
import { users } from "../../../users";
import { approvalRequests, workflows, workflowVersions } from "../../../approvals";
import { matchGroups, reconItems } from "../../schema";
import { reconConfigVersions } from "../../../recon";
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
/**
 * Each entry's levels become a published workflow of the space (version 1) named after it; the recon's published
 * version pins them for `change` (DEC-052 rev 2): an entry with `when` is a rule, one without is the default. Returns
 * the workflow ids.
 */
async function publish(change: string, rules: { name: string; when?: unknown; levels: unknown[] }[]) {
  const ids: string[] = [];
  for (const r of rules) {
    const id = Bun.randomUUIDv7();
    await db.insert(workflows).values({ id, spaceId: A, name: r.name });
    await db.insert(workflowVersions).values({ id: Bun.randomUUIDv7(), spaceId: A, workflowId: id, version: 1, status: "published", spec: { name: r.name, levels: r.levels } });
    ids.push(id);
  }
  const ref = (i: number) => ({ id: ids[i]!, version: 1 });
  const def = rules.findIndex((r) => !r.when);
  const setup = { workflow: { default: def < 0 ? null : ref(def), rules: rules.flatMap((r, i) => (r.when ? [{ name: r.name, when: r.when, workflow: ref(i) }] : [])) } };
  const [v] = await db.select().from(reconConfigVersions).where(and(eq(reconConfigVersions.configId, cfg), eq(reconConfigVersions.status, "published")));
  const spec = v!.spec as { approvals?: { changes: Record<string, unknown> } };
  await db.update(reconConfigVersions).set({ spec: { ...spec, approvals: { changes: { ...spec.approvals?.changes, [change]: setup } } } }).where(eq(reconConfigVersions.id, v!.id));
  return ids;
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
    expect(await message(await call("POST", path(I.a1, "/close"), { token: t.op, body: { resolution: "NO_ACTION", note: "x" } }))).toBe("A change of this item waits for a checker's decision.");
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

describe("the approvals inbox shows a request's amount, difference and workflow (audit §5.2)", () => {
  it("a force match: the item's amount and the gap; a write-off on a workflow: its name, no difference; a version: none of them", async () => {
    await req(I.a1, { kind: "force_match", itemIds: [I.b2], note: "Fee taken by the switch" });
    const rows = async (token = t.rev) => (await json<{ items: ApprovalRowDto[] }>(call("GET", `/v1/spaces/${A}/approvals`, { token }))).items;
    expect(await rows()).toMatchObject([{ kind: "force_match", amount: { minor: "10000", currency: "IDR" }, difference: { minor: "100", currency: "IDR" }, workflowName: null, level: { at: 1, of: 1 } }]);
    await decide(I.a1, "reject", { note: "Wrong pair" });
    await publish("write_off", [{ name: "Treasury head", levels: [{ name: "Head", groups: [group({ spaceRoles: ["reviewer"] })] }, { name: "Finance", groups: [group({ spaceRoles: ["space_admin"] })] }] }]);
    await req(I.a1, { kind: "write_off", note: "Below the threshold" });
    expect(await rows(t.op)).toMatchObject([{ kind: "write_off", amount: { minor: "10000", currency: "IDR" }, difference: null, workflowName: "Treasury head", level: { at: 1, of: 2 } }]);
  });
});

describe("the recon's pinned workflows: rules over break and side fields, levels in order, groups AND'd, one decision per person", () => {
  it("a write-off over 50.00 takes 2 levels (a reviewer, then a space admin); under it the plain rule", async () => {
    await publish("write_off", [
      { name: "Large", when: { all: [{ field: "break.amount", op: "gte", value: "5000" }] }, levels: [{ name: "Review", groups: [group({ spaceRoles: ["reviewer"] })] }, { name: "Head", groups: [group({ spaceRoles: ["space_admin"] })] }] },
      { name: "Small", levels: [{ name: "Any lead", groups: [group({ spaceRoles: ["reviewer", "space_admin"] })] }] },
    ]);
    await req(I.a1, { kind: "write_off", note: "Stale" }); // 100.00
    let d = await detail(I.a1, t.adm);
    expect(d.request).toMatchObject({ ruleName: "Large", workflowName: "Large", currentLevel: 0, levels: [{ name: "Review", state: "waiting" }, { name: "Head", state: "next" }] });
    expect(d.request!.blocked).toBe("Level 1 (Review) waits for 1 of Reviewer."); // the admin is level 2
    expect(await json(decide(I.a1, "approve", {}))).toEqual({ status: "pending" });
    expect((await state(I.a1)).st).toBe("pending_approval"); // nothing happens until the last level
    d = await detail(I.a1, t.adm);
    expect(d.request).toMatchObject({ currentLevel: 1, blocked: null, levels: [{ state: "done" }, { state: "waiting" }] });
    expect(await json(decide(I.a1, "approve", {}, t.adm))).toEqual({ status: "approved" });
    expect(await state(I.a1)).toMatchObject({ s: "closed", r: "WRITTEN_OFF" });
  });

  it("a rule on a side attr picks its workflow; another break takes the default (Every request)", async () => {
    await publish("write_off", [
      { name: "RTGS desk", when: { all: [{ field: "side_b.attrs.channel", op: "in", value: ["RTGS"] }] }, levels: [{ name: "Desk", groups: [group({ spaceRoles: ["space_admin"] })] }] },
      { name: "Plain", levels: [{ name: "Any lead", groups: [group({ spaceRoles: ["reviewer", "space_admin"] })] }] },
    ]);
    await db.update(records).set({ attrs: { channel: "RTGS" } }).where(eq(records.id, (await db.select({ r: reconItems.recordId }).from(reconItems).where(eq(reconItems.id, I.b2)))[0]!.r));
    await call("POST", `/v1/spaces/${A}/breaks/take`, { token: t.op, body: { ids: [I.b2] } });
    await req(I.b2, { kind: "write_off", note: "x" });
    expect((await detail(I.b2, t.adm)).request).toMatchObject({ ruleName: "RTGS desk", workflowName: "RTGS desk" });
    await req(I.a1, { kind: "write_off", note: "x" });
    expect((await detail(I.a1, t.adm)).request).toMatchObject({ ruleName: "Every request", workflowName: "Plain" });
  });

  it("a later published version of the workflow doesn't move the recon: new requests keep the pinned one", async () => {
    const [w] = await publish("write_off", [{ name: "Head", levels: [{ name: "Head", groups: [group({ spaceRoles: ["space_admin"] })] }] }]);
    await db.update(workflowVersions).set({ status: "retired" }).where(eq(workflowVersions.workflowId, w!));
    await db.insert(workflowVersions).values({ id: Bun.randomUUIDv7(), spaceId: A, workflowId: w!, version: 2, status: "published", spec: { name: "Head", levels: [
      { name: "Review", groups: [group({ spaceRoles: ["reviewer"] })] }, { name: "Head", groups: [group({ spaceRoles: ["space_admin"] })] },
    ] } });
    await req(I.a1, { kind: "write_off", note: "Stale" });
    expect((await detail(I.a1, t.adm)).request!.levels.map((l) => l.name)).toEqual(["Head"]);
  });

  it("a pinned version that no longer exists refuses the request and names the recon", async () => {
    const [w] = await publish("write_off", [{ name: "Head", levels: [{ name: "Head", groups: [group({ spaceRoles: ["space_admin"] })] }] }]);
    await db.delete(workflowVersions).where(eq(workflowVersions.workflowId, w!));
    const r = await req(I.a1, { kind: "write_off", note: "x" });
    expect([r.status, await message(r)]).toEqual([409, "The approval setup of this recon points to a workflow version that no longer exists. Ask a config maker to fix the recon."]);
  });

  it("preview: typed values pick the rule and show its levels with who would approve", async () => {
    await publish("unmatch", [
      { name: "RTGS desk", when: { all: [{ field: "side_a.attrs.channel", op: "in", value: ["RTGS"] }] }, levels: [{ name: "Desk", groups: [group({ spaceRoles: ["reviewer"] })] }] },
    ]);
    const [v] = await db.select({ id: reconConfigVersions.id }).from(reconConfigVersions).where(eq(reconConfigVersions.configId, cfg));
    const at = `/v1/spaces/${A}/recons/${cfg}/versions/${v!.id}/approvals/preview`;
    const p = await json<{ rule: { name: string }; workflow: { name: string; version: number } | null; levels: { name: string; groups: { approvers: { name: string }[] }[] }[] }>(
      call("POST", at, { token: t.op, body: { change: "unmatch", values: { "side_a.attrs.channel": "RTGS" } } }));
    expect([p.rule.name, p.workflow?.name, p.workflow?.version, p.levels[0]!.name, p.levels[0]!.groups[0]!.approvers.map((x) => x.name)]).toEqual(["RTGS desk", "RTGS desk", 1, "Desk", ["Google User"]]);
    const none = await json<{ rule: { name: string }; workflow: null }>(call("POST", at, { token: t.op, body: { change: "unmatch", values: {} } }));
    expect([none.rule.name, none.workflow]).toEqual(["Default", null]);
  });

  it("a force match reads the counterpart's side too: a rule on side B picks for a break of side A", async () => {
    await publish("force_match", [
      { name: "RTGS desk", when: { all: [{ field: "side_b.attrs.channel", op: "in", value: ["RTGS"] }, { field: "side_a.ext_ref", op: "eq", value: "P1" }] }, levels: [{ name: "Desk", groups: [group({ spaceRoles: ["space_admin"] })] }] },
    ]);
    await db.update(records).set({ attrs: { channel: "RTGS" } }).where(eq(records.id, (await db.select({ r: reconItems.recordId }).from(reconItems).where(eq(reconItems.id, I.b2)))[0]!.r));
    await req(I.a1, { kind: "force_match", itemIds: [I.b2], note: "Fee taken by the switch" });
    expect((await detail(I.a1, t.adm)).request).toMatchObject({ ruleName: "RTGS desk", workflowName: "RTGS desk" });
  });

  it("a workflow of another space pinned in this recon is never resolved: preview and request refuse it", async () => {
    const B = Bun.randomUUIDv7(), w = Bun.randomUUIDv7();
    await db.insert(spaces).values({ id: B, code: "payments", name: "Payments" });
    await db.insert(workflows).values({ id: w, spaceId: B, name: "Other space" });
    await db.insert(workflowVersions).values({ id: Bun.randomUUIDv7(), spaceId: B, workflowId: w, version: 1, status: "published", spec: { name: "Other space", levels: [{ name: "Theirs", groups: [group({ spaceRoles: ["reviewer"] })] }] } });
    const [v] = await db.select().from(reconConfigVersions).where(eq(reconConfigVersions.configId, cfg));
    await db.update(reconConfigVersions).set({ spec: { ...(v!.spec as object), approvals: { changes: { write_off: { workflow: { default: { id: w, version: 1 }, rules: [] } } } } } }).where(eq(reconConfigVersions.id, v!.id));
    const p = await call("POST", `/v1/spaces/${A}/recons/${cfg}/versions/${v!.id}/approvals/preview`, { token: t.op, body: { change: "write_off", values: {} } });
    expect([p.status, await code(p)]).toEqual([409, "invalid_state"]);
    expect(await code(await req(I.a1, { kind: "write_off", note: "x" }))).toBe("invalid_state");
  });

  it("a later publish of the workflow never moves an open request", async () => {
    const [w] = await publish("write_off", [{ name: "Head", levels: [{ name: "Head", groups: [group({ spaceRoles: ["space_admin"] })] }] }]);
    await req(I.a1, { kind: "write_off", note: "Stale" });
    await db.update(workflowVersions).set({ status: "retired" }).where(eq(workflowVersions.workflowId, w!));
    await db.insert(workflowVersions).values({ id: Bun.randomUUIDv7(), spaceId: A, workflowId: w!, version: 2, status: "published", spec: { name: "Head", levels: [
      { name: "Review", groups: [group({ spaceRoles: ["reviewer"] })] }, { name: "Head", groups: [group({ spaceRoles: ["space_admin"] })] },
    ] } });
    expect((await detail(I.a1, t.adm)).request!.levels.map((l) => l.name)).toEqual(["Head"]);
  });

  it("a person the workflow names who isn't a member of the space doesn't count", async () => {
    await publish("write_off", [{ name: "Outsider", levels: [{ name: "Named", groups: [group({ users: [await idOf("twofa")] })] }] }]);
    const r = await req(I.a1, { kind: "write_off", note: "x" });
    expect(await message(r)).toBe("Level 1 (Named) of the “Outsider” workflow has nobody else who can approve it. Ask a space admin or a workflow manager to fix it.");
  });

  it("one person decides one level; a level nobody else could pass is refused when asked", async () => {
    // all of the reviewers, but the only reviewer asks: refused with the level named
    await publish("force_match", [{ name: "Only", levels: [{ name: "Reviewers", groups: [group({ spaceRoles: ["reviewer"], need: { kind: "all" } })] }] }]);
    await call("POST", `/v1/spaces/${A}/breaks/assign`, { token: t.rev, body: { ids: [I.b2], assigneeId: await idOf("google") } });
    const r = await req(I.b2, { kind: "force_match", itemIds: [I.a1], note: "x" }, t.rev);
    expect(await message(r)).toBe("Level 1 (Reviewers) of the “Only” workflow has nobody else who can approve it. Ask a space admin or a workflow manager to fix it.");
    // the reviewer is in both levels: after level 1 they can't decide level 2, which then needs the admin
    await publish("write_off", [{ name: "Two", levels: [{ name: "A", groups: [group({ spaceRoles: ["reviewer", "space_admin"] })] }, { name: "B", groups: [group({ spaceRoles: ["reviewer", "space_admin"] })] }] }]);
    await req(I.a1, { kind: "write_off", note: "x" });
    await decide(I.a1, "approve", {});
    expect(await message(await decide(I.a1, "approve", {}))).toBe("You decided this request already. Each person decides one level.");
    expect(await json(decide(I.a1, "approve", {}, t.adm))).toEqual({ status: "approved" });
  });
});
