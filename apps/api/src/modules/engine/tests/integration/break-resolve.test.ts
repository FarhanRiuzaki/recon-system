// /v1/spaces/:spaceId/breaks/:itemId* (Plan 5 Task 2): a break's page; the other side's free items nearest amount
// first; a manual match whose sides total the same (else refused with the difference: a force match needs approval);
// the proposed pair in one click while its item is free; closing without a match with a note; only whoever has the
// break or a lead; one activity entry each; matched and closed breaks leave the queue.
import { beforeEach, describe, expect, it } from "bun:test";
import type { BreakDetailDto, BreakItemDto } from "@starterkit/shared/contracts/breaks";
import type { Page } from "@starterkit/shared/contracts/common";
import type { SpaceRole } from "@starterkit/shared/spaces";
import { eq } from "drizzle-orm";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { db } from "../../../../kernel/db";
import { ensureMonthPartitions } from "../../../../kernel/partitions";
import { activity } from "../../../audit";
import { records } from "../../../ingest";
import { spaceMembers, spaces } from "../../../spaces";
import { users } from "../../../users";
import { matchGroups, matchMembers, reconItems } from "../../schema";
import { D, makeSource, plainSource, put, recon, spec } from "../fixtures";

const idOf = async (username: string) => (await db.select({ id: users.id }).from(users).where(eq(users.username, username)))[0]!.id;
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const code = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;
const message = async (r: Response) => ((await r.json()) as { error: { message: string } }).error.message;

let A: string, cfg: string;
let t: Record<"op" | "op2" | "rev", string>;
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
  t = { op: await signIn("viewer"), op2: await signIn("apple"), rev: await signIn("google") };
  // the operator has the break
  await call("POST", `/v1/spaces/${A}/breaks/take`, { token: t.op, body: { ids: [I.a1] } });
});

const path = (id: string, what = "") => `/v1/spaces/${A}/breaks/${id}${what}`;

describe("a break's page and candidates", () => {
  it("shows the item, its recon's sides and where it stands; the other side's free items, nearest amount first", async () => {
    const d = await json<BreakDetailDto>(call("GET", path(I.a1), { token: t.op2 }));
    expect(d).toMatchObject({ item: { ref: "P1", side: "a", amountMinor: "10000" }, state: "assigned", resolution: null, matchedWith: [], proposed: null });
    expect(d.recon.sides).toHaveLength(2);
    const c = await json<Page<BreakItemDto>>(call("GET", path(I.a1, "/candidates"), { token: t.op2 }));
    expect(c.items.map((x) => x.ref)).toEqual(["P1", "P3", "P2"]); // 0 off (P1, P3), then 100 off; a1's own side never
    expect((await json<Page<BreakItemDto>>(call("GET", path(I.a1, "/candidates?q=P2"), { token: t.op }))).items.map((x) => x.ref)).toEqual(["P2"]);
    expect((await call("GET", path(I.b1), { token: t.op })).status).toBe(404); // b1 never broke
  });
});

describe("resolving without approval", () => {
  it("a manual match whose totals agree: a manual group, both matched, the break resolved MATCHED_MANUAL, out of the queue", async () => {
    // someone else's break: only whoever has it, or a lead
    const other = await call("POST", path(I.a1, "/match"), { token: t.op2, body: { itemIds: [I.b1] } });
    expect([other.status, await code(other)]).toEqual([403, "forbidden"]);
    const d = await json<BreakDetailDto>(call("POST", path(I.a1, "/match"), { token: t.op, body: { itemIds: [I.b1], note: "Same transfer" } }));
    expect(d).toMatchObject({ state: "resolved", resolution: "MATCHED_MANUAL", item: { status: "matched" }, matchedWith: [{ ref: "P1", side: "b", status: "matched" }] });
    const [g] = await db.select().from(matchGroups).where(eq(matchGroups.configId, cfg));
    expect(g).toMatchObject({ kind: "manual", runId: null, passNo: 0 });
    expect((await db.select().from(matchMembers).where(eq(matchMembers.groupId, g!.id))).length).toBe(2);
    expect((await json<Page<unknown>>(call("GET", `/v1/spaces/${A}/breaks`, { token: t.op }))).items.length).toBe(1); // b2 is left
    const [a] = await db.select({ action: activity.action, after: activity.after }).from(activity).where(eq(activity.action, "break.match"));
    expect(a!.after).toMatchObject({ resolution: "MATCHED_MANUAL", note: "Same transfer" });
    // matched once: a second match refuses
    const again = await call("POST", path(I.a1, "/match"), { token: t.op, body: { itemIds: [I.b3] } });
    expect([again.status, await code(again)]).toEqual([409, "invalid_state"]);
  });

  it("refuses totals that differ (with the difference), another currency, and items of one side only", async () => {
    const off = await call("POST", path(I.a1, "/match"), { token: t.op, body: { itemIds: [I.b2] } });
    const e = ((await off.json()) as { error: { code: string; message: string } }).error;
    expect([off.status, e.code]).toEqual([409, "invalid_state"]);
    expect(e.message).toMatch(/differ by 1\.00\. A match across a difference needs approval \(force match\)\.$/);
    const ccy = await call("POST", path(I.a1, "/match"), { token: t.op, body: { itemIds: [I.b1, I.b3] } });
    expect([ccy.status, await message(ccy)]).toEqual([400, "These items are in different currencies. Match items of one currency."]);
    // a reviewer works anyone's break; the totals still have to agree
    expect((await call("POST", path(I.a1, "/match"), { token: t.rev, body: { itemIds: [I.b1] } })).status).toBe(200);
  });

  it("the proposed pair in one click while its item is free; gone, it says so", async () => {
    await db.update(reconItems).set({ proposedItemId: I.b2, proposedPass: 1 }).where(eq(reconItems.id, I.a1));
    const d = await json<BreakDetailDto>(call("GET", path(I.a1), { token: t.op }));
    expect(d.proposed).toMatchObject({ item: { ref: "P2" }, pass: 1, available: true });
    // a pair a pass proposed within its tolerance needs no equal totals (DEC-047)
    expect(await json<BreakDetailDto>(call("POST", path(I.a1, "/match-pair"), { token: t.op }))).toMatchObject({ resolution: "MATCHED_MANUAL", matchedWith: [{ ref: "P2" }] });
  });

  it("closes without a match with a note; it leaves the queue and no longer counts as an open break", async () => {
    const none = await call("POST", path(I.a1, "/close"), { token: t.op, body: { resolution: "DUPLICATE", note: " " } });
    expect(none.status).toBe(400);
    const d = await json<BreakDetailDto>(call("POST", path(I.a1, "/close"), { token: t.op, body: { resolution: "DUPLICATE", note: "Sent twice by the core" } }));
    expect(d).toMatchObject({ state: "resolved", resolution: "DUPLICATE", item: { status: "closed" } });
    const trail = await json<Page<{ action: string }>>(call("GET", path(I.a1, "/activity"), { token: t.op2 }));
    expect(trail.items.map((x) => x.action)).toEqual(["break.close", "break.take"]);
  });
});
