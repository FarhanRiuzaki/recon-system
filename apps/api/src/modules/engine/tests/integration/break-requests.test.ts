// Break requests (Plan 5 Task 3): force match, unmatch and write-off, asked with a note by whoever works the break,
// decided by a reviewer or space admin who didn't ask (a Superadmin decides anything); one pending per break.
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
import { approvalRequests, matchGroups, reconItems } from "../../schema";
import { D, makeSource, plainSource, put, recon, spec } from "../fixtures";

const idOf = async (username: string) => (await db.select({ id: users.id }).from(users).where(eq(users.username, username)))[0]!.id;
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const code = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;
const message = async (r: Response) => ((await r.json()) as { error: { message: string } }).error.message;

let A: string, cfg: string;
let t: Record<"op" | "op2" | "rev" | "sa", string>;
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
  t = { op: await signIn("viewer"), op2: await signIn("apple"), rev: await signIn("google"), sa: await signIn("superadmin") };
  // the operator has the break
  await call("POST", `/v1/spaces/${A}/breaks/take`, { token: t.op, body: { ids: [I.a1] } });
});

const path = (id: string, what = "") => `/v1/spaces/${A}/breaks/${id}${what}`;


const req = (id: string, b: unknown, token = t.op) => call("POST", path(id, "/request"), { token, body: b });
const decide = (id: string, how: "approve" | "reject", b: unknown, token = t.rev) => call("POST", path(id, `/request/${how}`), { token, body: b });
const state = async (id: string) => (await db.select({ s: reconItems.status, st: reconItems.breakState, r: reconItems.resolution }).from(reconItems).where(eq(reconItems.id, id)))[0]!;

describe("break requests: asked by whoever works the break, decided by another lead", () => {
  it("a force match: only for totals that differ; pending holds the break; approved by a reviewer, by them, FORCE_MATCHED", async () => {
    const agree = await req(I.a1, { kind: "force_match", itemIds: [I.b1], note: "x" });
    expect([agree.status, await message(agree)]).toEqual([409, "These totals agree: match them without approval."]);
    expect((await req(I.a1, { kind: "force_match", itemIds: [I.b2], note: " " })).status).toBe(400); // a note says why
    const d = await json<BreakDetailDto>(req(I.a1, { kind: "force_match", itemIds: [I.b2], note: "Fee taken by the switch" }));
    expect(d).toMatchObject({ state: "pending_approval", request: { kind: "force_match", note: "Fee taken by the switch", items: [{ ref: "P2" }], blocked: "You asked for this. A reviewer or space admin who didn't ask decides it." } });
    // one at a time; the break can't be resolved meanwhile; its counterpart is no longer offered
    expect(await code(await req(I.a1, { kind: "write_off", note: "x" }))).toBe("invalid_state");
    expect(await message(await call("POST", path(I.a1, "/close"), { token: t.op, body: { resolution: "NO_ACTION", note: "x" } }))).toBe("A change of this break waits for a checker's decision.");
    // an operator can't decide; the inbox lists it for the reviewer, with why for the operator
    expect((await decide(I.a1, "approve", {}, t.op2)).status).toBe(403);
    const inbox = await json<{ items: ApprovalRowDto[] }>(call("GET", `/v1/spaces/${A}/approvals?mine=1`, { token: t.rev }));
    expect(inbox.items).toMatchObject([{ kind: "force_match", target: { id: I.a1, code: "P1" }, version: null, blocked: null }]);
    expect((await json<{ items: ApprovalRowDto[] }>(call("GET", `/v1/spaces/${A}/approvals?mine=1`, { token: t.op }))).items).toEqual([]);
    const done = await json<BreakDetailDto>(decide(I.a1, "approve", { note: "Checked the fee schedule" }));
    expect(done).toMatchObject({ state: "resolved", resolution: "FORCE_MATCHED", request: null, matchedWith: [{ ref: "P2" }] });
    expect(await state(I.b2)).toEqual({ s: "matched", st: "resolved", r: "FORCE_MATCHED" });
    const [g] = await db.select({ evidence: matchGroups.evidence }).from(matchGroups).where(eq(matchGroups.configId, cfg));
    expect(g!.evidence).toMatchObject({ resolution: "FORCE_MATCHED", kind: "force_match", by: await idOf("google") });
    const [r] = await db.select().from(approvalRequests);
    expect(r).toMatchObject({ status: "approved", decidedBy: await idOf("google"), decisionNote: "Checked the fee schedule" });
    const trail = await json<{ items: { action: string }[] }>(call("GET", path(I.a1, "/activity"), { token: t.op }));
    expect(trail.items.map((x) => x.action)).toEqual(["break.approve", "break.request", "break.take"]);
  });

  it("the one who asked can't decide (self_approval), unless a Superadmin (DEC-051)", async () => {
    await call("POST", `/v1/spaces/${A}/breaks/assign`, { token: t.rev, body: { ids: [I.a1], assigneeId: await idOf("google") } });
    await req(I.a1, { kind: "write_off", note: "Below the bank's threshold" }, t.rev);
    const self = await decide(I.a1, "approve", {});
    expect([self.status, await code(self)]).toEqual([409, "self_approval"]);
    expect(await state(I.a1)).toMatchObject({ s: "break", st: "pending_approval" });
    expect(await json<BreakDetailDto>(decide(I.a1, "approve", {}, t.sa))).toMatchObject({ state: "resolved", resolution: "WRITTEN_OFF", item: { status: "closed" } });
  });

  it("rejected with a note: the break goes back to the state it had", async () => {
    await call("POST", `/v1/spaces/${A}/breaks/state`, { token: t.op, body: { ids: [I.a1], state: "investigating" } });
    await req(I.a1, { kind: "write_off", note: "Old item" });
    expect((await decide(I.a1, "reject", { note: "" })).status).toBe(400);
    expect(await json<BreakDetailDto>(decide(I.a1, "reject", { note: "Find the counterpart first" }))).toMatchObject({ state: "investigating", request: null });
    expect((await db.select().from(approvalRequests))[0]).toMatchObject({ status: "rejected", decisionNote: "Find the counterpart first" });
  });

  it("unmatch: the match reversed by the checker; breaks back in the queue, an item that never broke open again", async () => {
    await call("POST", path(I.a1, "/match"), { token: t.op, body: { itemIds: [I.b1] } });
    expect(await code(await req(I.b2, { kind: "unmatch", note: "x" }, t.rev))).toBe("invalid_state"); // b2 is not matched
    await req(I.a1, { kind: "unmatch", note: "Wrong transfer" });
    expect(await state(I.a1)).toMatchObject({ s: "matched", st: "resolved" }); // unchanged until decided
    expect(await json<BreakDetailDto>(decide(I.a1, "approve", {}))).toMatchObject({ state: "assigned", resolution: null, matchedWith: [] });
    expect(await state(I.b1)).toEqual({ s: "open", st: null, r: null });
    const [g] = await db.select().from(matchGroups).where(eq(matchGroups.configId, cfg));
    expect(g).toMatchObject({ reverseReason: "unmatch", reversedBy: await idOf("google") });
  });
});
