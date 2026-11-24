// Grouped posting (stage 5, design §4.6.5, O7/O10): an approved break joins the open group of its key values,
// currency and period (approval date, Asia/Jakarta; at or after the cutoff the next day; after its recon day started
// closing the next day), once per request; the group is sent as one run when it closes (its cutoff, or the recon day's
// close), once; sign-off waits for it.
import { beforeEach, describe, expect, it } from "bun:test";
import type { BreakDetailDto } from "@starterkit/shared/contracts/breaks";
import { periodOf } from "@starterkit/shared/mapping";
import type { SpaceRole } from "@starterkit/shared/spaces";
import { and, asc, eq } from "drizzle-orm";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { holdTx, lockWaiters } from "../../../../../test/helpers/db";
import { decryptSecret } from "../../../../kernel/crypto";
import { db } from "../../../../kernel/db";
import { ensureMonthPartitions } from "../../../../kernel/partitions";
import { workflows, workflowVersions } from "../../../approvals";
import { records } from "../../../ingest";
import { actionRuns, closeDueGroups, closeGroup, closeGroupsOfDay, connectors, connectorVersions, integrationsHandlers, joinGroup, postingGroupItems, postingGroups, sendRun } from "../../../integrations";
import { boss, QUEUES } from "../../../../kernel/jobs";
import { closeDay } from "../../breaks";
import { closeMoment } from "../../rules";
import { reconConfigVersions } from "../../../recon";
import { spaceMembers, spaces, withSpace } from "../../../spaces";
import { users } from "../../../users";
import { reconDays, reconItems } from "../../schema";
import { ccyEq, D, makeSource, plainSource, put, recon, spec } from "../fixtures";

const idOf = async (username: string) => (await db.select({ id: users.id }).from(users).where(eq(users.username, username)))[0]!.id;
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
let A: string, cfg: string, cid: string;
let t: Record<"op" | "rev" | "adm", string>;
let I: Record<"a1" | "a2" | "b2", string>;
const env = { baseUrl: "", host: "", partnerId: "", channelId: "", verifyTls: false };
const OP = { key: "post", name: "Post", method: "POST", path: "/post", timeoutMs: 30000,
  request: [{ name: "Amount", type: "numeric", required: true }, { name: "Remark", type: "string", required: true },
    { name: "Items", type: "array", required: false, children: [{ name: "Ref", type: "string", required: true }] }],
  response: [], success: null, reference: null, masked: [], presets: {}, auto: {} };
const anyOf = { spaceRoles: ["reviewer"], globalRoles: [], users: [], need: { kind: "any" } };
const grouped = (group: object, o: object = {}) => ({ name: "Grouped", when: null, operation: { connectorId: cid, version: 1, key: "post" }, per: "group", zeroOrNegative: "skip",
  group: { key: ["break.reason"], at: "day_close", cutoff: null, ...group },
  mapping: { Amount: { kind: "field", key: "group.sum", transforms: [] }, Remark: { kind: "template", text: "{group.count} items {group.key.break.reason}" }, "Items.Ref": { kind: "field", key: "break.reference", transforms: [] } }, ...o });
const today = () => periodOf(new Date(), null);
const tomorrow = () => new Date(Date.parse(`${today()}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** The recon's published version: write-off by one reviewer, a posting action with this variant. */
async function setup(variant: object, action: object = {}) {
  const w = Bun.randomUUIDv7();
  await db.insert(workflows).values({ id: w, spaceId: A, name: `One level ${w}` });
  await db.insert(workflowVersions).values({ id: Bun.randomUUIDv7(), spaceId: A, workflowId: w, version: 1, status: "published", spec: { name: "One level", levels: [{ name: "Review", groups: [anyOf] }] } });
  const [v] = await db.select().from(reconConfigVersions).where(and(eq(reconConfigVersions.configId, cfg), eq(reconConfigVersions.status, "published")));
  await db.update(reconConfigVersions).set({ spec: { ...(v!.spec as object), approvals: { accounts: [], lookups: [], changes: { write_off: { workflow: { default: { id: w, version: 1 }, rules: [] },
    actions: [{ name: "Post", kind: "posting", on: { event: "approved" }, variants: [variant], ...action }] } } } } }).where(eq(reconConfigVersions.id, v!.id));
}
const detail = (id: string, token = t.op) => json<BreakDetailDto>(call("GET", `/v1/spaces/${A}/breaks/${id}`, { token }));
const ask = (id: string) => call("POST", `/v1/spaces/${A}/breaks/${id}/request`, { token: t.op, body: { kind: "write_off", note: "Stale" } });
const approve = async (id: string) => call("POST", `/v1/spaces/${A}/approval-requests/${(await detail(id, t.rev)).request!.id}/approve`, { token: t.rev, body: {} });
const groups = () => db.select().from(postingGroups).orderBy(asc(postingGroups.period), asc(postingGroups.part), asc(postingGroups.createdAt));
const members = () => db.select().from(postingGroupItems).orderBy(asc(postingGroupItems.joinedAt));

beforeEach(async () => {
  await resetData();
  await db.delete(spaces);
  await db.delete(connectors);
  A = Bun.randomUUIDv7();
  await db.insert(spaces).values({ id: A, code: "treasury", name: "Treasury" });
  const grant = async (u: string, role: SpaceRole) => db.insert(spaceMembers).values({ spaceId: A, userId: await idOf(u), role });
  await grant("viewer", "operator"); await grant("google", "reviewer"); await grant("admin", "space_admin");
  await db.transaction(async (tx) => {
    await ensureMonthPartitions(tx, records, new Date(`${D}T00:00:00Z`), 1);
    await ensureMonthPartitions(tx, reconItems, new Date(`${D}T00:00:00Z`), 1);
  });
  const [sa, sb] = [await makeSource(A, plainSource()), await makeSource(A, plainSource())];
  const [ra1, ra2] = await put(sa, [{ ref: "P1", amount: 10_000n }, { ref: "P2", amount: 2_500n }]);
  const [, rb2] = await put(sb, [{ ref: "Q1", amount: 10_000n }, { ref: "Q2", amount: 9_900n }]);
  cfg = (await recon(A, spec(sa.sourceId, sb.sourceId, [{ no: 1, name: "Exact", cardinality: "1:1", blocking: ["ext_ref"], accept: "auto", on_ambiguous: "break", predicates: [ccyEq, { op: "eq", field: "amount_minor" }] }]))).configId;
  const item = (side: "a" | "b", recordId: string) => ({ id: Bun.randomUUIDv7(), spaceId: A, configId: cfg, recordId, side, status: "break", businessDate: D, breakReason: "No counterpart" });
  const rows = { a1: item("a", ra1!), a2: item("a", ra2!), b2: item("b", rb2!) };
  await db.insert(reconItems).values(Object.values(rows));
  I = { a1: rows.a1.id, a2: rows.a2.id, b2: rows.b2.id };
  cid = Bun.randomUUIDv7();
  await db.insert(connectors).values({ id: cid, name: "Bank Mega" });
  await db.insert(connectorVersions).values({ id: Bun.randomUUIDv7(), connectorId: cid, version: 1, status: "published", spec: { name: "Bank Mega", profile: "bank_mega_openapi_2_1", active: "dev", environments: { dev: env, prod: env }, operations: [OP] } });
  t = { op: await signIn("viewer"), rev: await signIn("google"), adm: await signIn("admin") };
  await call("POST", `/v1/spaces/${A}/breaks/take`, { token: t.op, body: { ids: [I.a1, I.a2, I.b2] } });
});

describe("joining a group in the approval", () => {
  it("approved breaks with the same key join one open group of today; no run is written yet", async () => {
    await setup(grouped({}));
    for (const id of [I.a1, I.a2]) { await ask(id); await approve(id); }
    const [g, ...more] = await groups();
    expect(more).toEqual([]);
    expect(g).toMatchObject({ status: "open", period: today(), part: 1, members: 2, totalMinor: 12_500n, currency: "IDR", negative: false, at: "day_close", closesAt: closeMoment(spec("", "", []) as never, today()),
      keys: [{ field: "break.reason", label: "Break reason", value: "No counterpart" }] });
    expect((await members()).map((m) => [m.itemId, m.ref])).toEqual([[I.a1, "P1"], [I.a2, "P2"]]);
    expect(await db.select().from(actionRuns)).toEqual([]);
  });

  it("another key value is another group; an empty one is a group with an empty value, not dropped", async () => {
    await setup(grouped({ key: ["side_a.ext_ref"] }));
    for (const id of [I.a1, I.b2]) { await ask(id); await approve(id); }
    expect((await groups()).map((g) => (g.keys as { value: string }[])[0]!.value).sort()).toEqual(["", "P1"]);
  });

  it("at or after the cutoff the next day's period; a cutoff group closes at that time", async () => {
    await setup(grouped({ at: "cutoff", cutoff: "00:00" }));
    await ask(I.a1); await approve(I.a1);
    const [g] = await groups();
    expect([g!.period, g!.closesAt?.toISOString()]).toEqual([tomorrow(), new Date(`${tomorrow()}T00:00:00+07:00`).toISOString()]);
  });

  it("once today's recon day has started closing, or its group is closed, a joiner opens tomorrow's", async () => {
    await setup(grouped({}));
    await db.insert(reconDays).values({ spaceId: A, configId: cfg, businessDate: today(), status: "closing" });
    await ask(I.a1); await approve(I.a1);
    expect((await groups()).map((g) => g.period)).toEqual([tomorrow()]);
    await db.delete(reconDays);
    await db.update(postingGroups).set({ period: today(), status: "closed" });
    await ask(I.a2); await approve(I.a2);
    expect((await groups()).map((g) => [g.period, g.status])).toEqual([[today(), "closed"], [tomorrow(), "open"]]);
  });

  it("a full group opens part 2 of the same period", async () => {
    await setup(grouped({}));
    await ask(I.a1); await approve(I.a1);
    await db.update(postingGroups).set({ members: 500 });
    await ask(I.a2); await approve(I.a2);
    expect((await groups()).map((g) => [g.part, g.members])).toEqual([[1, 500], [2, 1]]);
  });

  it("two approvals at once into a new group: one group, two members", async () => {
    await setup(grouped({}));
    await ask(I.a1); await ask(I.a2);
    const ids = [(await detail(I.a1, t.rev)).request!.id, (await detail(I.a2, t.rev)).request!.id];
    await Promise.all(ids.map((id) => call("POST", `/v1/spaces/${A}/approval-requests/${id}/approve`, { token: t.rev, body: {} })));
    expect((await groups()).map((g) => g.members)).toEqual([2]);
    expect(await members()).toHaveLength(2);
  });

  it("Approve clicked twice at once: one member", async () => {
    await setup(grouped({}));
    await ask(I.a1);
    const id = (await detail(I.a1, t.rev)).request!.id;
    await Promise.all([1, 2].map(() => call("POST", `/v1/spaces/${A}/approval-requests/${id}/approve`, { token: t.rev, body: {} })));
    expect(await members()).toHaveLength(1);
  });
});

describe("reading groups: the recon's tab, the break, the posting list", () => {
  it("the list pages newest period first and filters open or closed; the detail lists its breaks; another recon's group is 404", async () => {
    await setup(grouped({ key: ["side_a.ext_ref"] }));
    for (const id of [I.a1, I.b2]) { await ask(id); await approve(id); }
    const page = await json<{ items: { keys: unknown; items: number; totalMinor: string; status: string; run: unknown }[]; total: number }>(call("GET", `/v1/spaces/${A}/recons/${cfg}/posting-groups`, { token: t.op }));
    expect(page.total).toBe(2);
    expect(page.items.map((g) => g.keys).sort()).toEqual([[{ label: "Reference", value: "" }], [{ label: "Reference", value: "P1" }]]);
    const [g] = await groups();
    await withSpace({ spaceIds: [A], userId: null }, (tx) => closeGroup(tx, A, g!.id));
    const open = await json<{ total: number }>(call("GET", `/v1/spaces/${A}/recons/${cfg}/posting-groups?status=open`, { token: t.op }));
    expect(open.total).toBe(1);
    const one = await json<{ status: string; run: { status: string } | null; members: { itemId: string; ref: string | null; amountMinor: string | null }[] }>(call("GET", `/v1/spaces/${A}/recons/${cfg}/posting-groups/${g!.id}`, { token: t.op }));
    expect([one.status, one.run?.status, one.members.length]).toEqual(["closed", "queued", 1]);
    expect((await call("GET", `/v1/spaces/${A}/recons/${Bun.randomUUIDv7()}/posting-groups/${g!.id}`, { token: t.op })).status).toBe(404);
    expect((await call("GET", `/v1/spaces/${A}/recons/${cfg}/posting-groups?status=nope`, { token: t.op })).status).toBe(400);
  });

  it("the break waits in its group (period, key, when), then shows the group's run; the posting list names the group", async () => {
    await setup(grouped({ at: "cutoff", cutoff: "00:00" }));
    await ask(I.a1); await approve(I.a1);
    let d = await detail(I.a1);
    expect(d.posting?.status).toBe("grouped");
    expect(d.actions.at(-1)).toMatchObject({ status: "grouped", name: "Post", group: { period: tomorrow(), at: "cutoff", keys: [{ label: "Break reason", value: "No counterpart" }], items: 1 } });
    await withSpace({ spaceIds: [A], userId: null }, (tx) => closeGroupsOfDay(tx, A, cfg, tomorrow()));
    d = await detail(I.a1);
    expect([d.posting?.status, d.actions.at(-1)?.group?.period]).toEqual(["queued", tomorrow()]);
    const runs = await json<{ items: { group: { items: number } | null; amount: { minor: string } | null }[] }>(call("GET", `/v1/spaces/${A}/action-runs?show=all`, { token: t.op }));
    expect(runs.items.map((r) => [r.group?.items, r.amount?.minor])).toEqual([[1, "10000"]]);
  });
});

describe("what gets posted for a grouped variant", () => {
  const preview = async (itemId: string) => {
    const [v] = await db.select({ id: reconConfigVersions.id }).from(reconConfigVersions).where(eq(reconConfigVersions.configId, cfg));
    return json<{ payload: unknown; problem: unknown; context: Record<string, unknown> }>(call("POST", `/v1/spaces/${A}/recons/${cfg}/versions/${v!.id}/actions/preview`, { token: t.adm, body: { change: "write_off", action: 0, itemId } }));
  };
  it("a sample group of the chosen break and a break of the same key: the total, not the first break's amount (review C1)", async () => {
    await setup(grouped({}, { mapping: { ...grouped({}).mapping, Amount: { kind: "field", key: "break.amount", transforms: [] } } }));
    expect(await preview(I.a1)).toMatchObject({ payload: { Amount: 12500, Remark: "2 items No counterpart", Items: [{ Ref: "P1" }, { Ref: "P2" }] }, problem: null,
      context: { "group.count": 2, "group.sum": "12500", "group.key.break.reason": "No counterpart" } });
  });
  it("no other break shares the key: the sample group holds the chosen break twice", async () => {
    await setup(grouped({ key: ["side_a.ext_ref"] }));
    expect(await preview(I.a1)).toMatchObject({ payload: { Amount: 20000, Remark: "2 items ", Items: [{ Ref: "P1" }, { Ref: "P1" }] }, problem: null });
  });
  it("a masked request field hides the group key it reads in the example values", async () => {
    await setup(grouped({ key: ["side_a.ext_ref"] }, { mapping: { ...grouped({}).mapping, Remark: { kind: "field", key: "group.key.side_a.ext_ref", transforms: [] } } }));
    const [cv] = await db.select().from(connectorVersions).where(eq(connectorVersions.connectorId, cid));
    await db.update(connectorVersions).set({ spec: { ...(cv!.spec as object), operations: [{ ...OP, masked: ["Remark"] }] } }).where(eq(connectorVersions.id, cv!.id));
    const p = await preview(I.a1);
    expect(p.context["group.key.side_a.ext_ref"]).not.toBe("P1");
    expect(JSON.stringify(p.payload)).not.toContain("\"Remark\":\"P1\"");
  });
});

describe("sign-off waits for the day's posting groups", () => {
  it("prepare is refused while a group up to that day is open or its run waits; the day list says why", async () => {
    await setup(grouped({}));
    await ask(I.a1); await approve(I.a1);
    await db.insert(reconDays).values({ spaceId: A, configId: cfg, businessDate: today(), status: "closed", closedAt: new Date() });
    const prepare = () => call("POST", `/v1/spaces/${A}/recons/${cfg}/signoffs/prepare`, { token: t.adm, body: { date: today() } });
    const why = "1 posting group of this day is still open or being sent. Wait for it to be sent.";
    let r = await prepare();
    expect([r.status, ((await r.json()) as { error: { code: string; message: string } }).error]).toEqual([409, { code: "invalid_state", message: why }]);
    const list = await json<{ items: { date: string; blocked: string | null }[] }>(call("GET", `/v1/spaces/${A}/recons/${cfg}/signoffs`, { token: t.adm }));
    expect(list.items.find((d) => d.date === today())!.blocked).toBe(why);
    await withSpace({ spaceIds: [A], userId: null }, (tx) => closeGroupsOfDay(tx, A, cfg, today()));
    expect((await prepare()).status).toBe(409); // its run is still queued
    await db.update(actionRuns).set({ status: "posted" });
    r = await prepare();
    expect(r.status).toBe(200);
  });
});

describe("closing a group", () => {
  const close = (d = today()) => withSpace({ spaceIds: [A], userId: null }, (tx) => closeGroupsOfDay(tx, A, cfg, d));

  it("one run with the group's payload, its members pointing at it, its values cleared; closing again writes nothing", async () => {
    await setup(grouped({}));
    for (const id of [I.a1, I.a2]) { await ask(id); await approve(id); }
    expect(await close()).toBe(1);
    expect(await close()).toBe(0);
    const [g] = await groups(), runs = await db.select().from(actionRuns);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ groupId: g!.id, requestId: null, itemId: null, status: "queued", actionName: "Post", variantName: "Grouped", kind: "posting", event: "approved", seq: 1 });
    expect(JSON.parse(decryptSecret(runs[0]!.payloadEnc!))).toEqual({ Amount: 12500, Remark: "2 items No counterpart", Items: [{ Ref: "P1" }, { Ref: "P2" }] });
    expect([g!.status, g!.runId]).toEqual(["closed", runs[0]!.id]);
    expect((await members()).map((m) => m.context)).toEqual([null, null]);
    // the worker takes it at once (no request, so no earlier run to wait for); this test bank is unreachable
    expect(await sendRun(db, A, runs[0]!.id)).not.toBe("waiting");
    expect((await db.select({ s: actionRuns.status }).from(actionRuns))[0]!.s).not.toBe("queued");
  });

  it("the cutoff job closes groups whose time has passed, and no others", async () => {
    await setup(grouped({ at: "cutoff", cutoff: "16:00" }));
    await ask(I.a1); await approve(I.a1);
    const [g] = await groups();
    expect(await closeDueGroups(db, new Date(g!.closesAt!.getTime() - 1000))).toBe(0);
    expect(await closeDueGroups(db, g!.closesAt!)).toBe(1);
    expect((await groups())[0]!.status).toBe("closed");
  });

  it("the recon day's close sends its day-close groups and its cutoff groups early; the per-minute job does the cutoff ones", async () => {
    await setup(grouped({}));
    await ask(I.a1); await approve(I.a1);
    expect(await closeDay(db, { spaceId: A, configId: cfg }, today(), new Date(Date.now() + 3 * 86_400_000))).not.toBe("not_due");
    expect((await groups()).map((g) => g.status)).toEqual(["closed"]);
    expect(await db.select({ s: actionRuns.status }).from(actionRuns)).toEqual([{ s: "queued" }]);
    await setup(grouped({ at: "cutoff", cutoff: "00:00" }));
    await db.delete(reconDays);
    await ask(I.a2); await approve(I.a2); // tomorrow's, closes at tomorrow 00:00 WIB
    await integrationsHandlers(db)[QUEUES.integrationsAction]!({ data: { groups: true } } as never);
    expect((await groups()).map((g) => g.status)).toEqual(["closed", "open"]);
  });

  it("an empty group closes without a run", async () => {
    await setup(grouped({}));
    await ask(I.a1); await approve(I.a1);
    await db.delete(postingGroupItems);
    await db.update(postingGroups).set({ members: 0 });
    expect(await close()).toBe(1);
    expect(await db.select().from(actionRuns)).toEqual([]);
  });
});

describe("review fixes (stage 5)", () => {
  const close = (d = today()) => withSpace({ spaceIds: [A], userId: null }, (tx) => closeGroupsOfDay(tx, A, cfg, d));
  const payloads = async () => (await db.select().from(actionRuns).orderBy(asc(actionRuns.createdAt))).map((r) => (r.payloadEnc ? JSON.parse(decryptSecret(r.payloadEnc)) : r.code));

  it("C1: a variant mapping the break's amount sends the group's total; the break's other fields are the first break's", async () => {
    await setup(grouped({}, { mapping: { Amount: { kind: "field", key: "break.amount", transforms: [] }, Remark: { kind: "field", key: "break.reference", transforms: [] } } }));
    for (const id of [I.a1, I.a2]) { await ask(id); await approve(id); }
    await close();
    expect(await payloads()).toEqual([{ Amount: 12500, Remark: "P1" }]);
  });

  it("I2: an approval while the day close is closing that day's groups waits for it, then joins the next day's group", async () => {
    await setup(grouped({}));
    await ask(I.a1);
    const id = (await detail(I.a1, t.rev)).request!.id;
    const held = await holdTx((tx) => withSpace({ spaceIds: [A], userId: null }, async (s) => {
      await closeGroupsOfDay(s, A, cfg, today());
      await s.insert(reconDays).values({ spaceId: A, configId: cfg, businessDate: today(), status: "closing" });
    }, tx));
    try {
      const approving = call("POST", `/v1/spaces/${A}/approval-requests/${id}/approve`, { token: t.rev, body: {} });
      expect(await lockWaiters(1, "%pg_advisory_xact_lock_shared%")).toBe(true);
      await held.commit();
      expect((await approving).status).toBe(200);
      expect((await groups()).map((g) => [g.period, g.status])).toEqual([[tomorrow(), "open"]]);
    } finally {
      await held.rollback();
    }
  });

  it("I3: a day-close group its day close never came for shows late, then the per-minute job sends it once close + grace has passed", async () => {
    await setup(grouped({}));
    await ask(I.a1); await approve(I.a1);
    const late = new Date(Date.now() - 10 * 60_000);
    await db.update(postingGroups).set({ closesAt: late });
    const page = await json<{ items: { late: boolean }[] }>(call("GET", `/v1/spaces/${A}/recons/${cfg}/posting-groups`, { token: t.op }));
    expect(page.items.map((g) => g.late)).toEqual([true]);
    const today_ = await json<{ posting: { reconId: string; lateGroups: number; failed: number; timeout: number; notSent: number }[] }>(call("GET", `/v1/spaces/${A}/today`, { token: t.op }));
    expect(today_.posting).toEqual([{ reconId: cfg, failed: 0, timeout: 0, notSent: 0, lateGroups: 1 }]);
    const due = late.getTime() + 30 * 60_000; // the fixture's grace
    expect(await closeDueGroups(db, new Date(due - 1000))).toBe(0);
    expect(await closeDueGroups(db, new Date(due))).toBe(1);
    expect((await groups()).map((g) => g.status)).toEqual(["closed"]);
  });

  it("I4: a negative break opens a group of its own sign; absolute_swap sends each total without its sign", async () => {
    const variant = grouped({}, { zeroOrNegative: "absolute_swap", mapping: { Amount: { kind: "field", key: "break.amount", transforms: ["abs"] }, Remark: { kind: "const", value: "x" } } });
    await setup(variant);
    const [v] = await db.select().from(reconConfigVersions).where(and(eq(reconConfigVersions.configId, cfg), eq(reconConfigVersions.status, "published")));
    const target = { spaceId: A, configId: cfg, configVersionId: v!.id, change: "write_off", actionIndex: 0, variantIndex: 0, actionName: "Post", variant: variant as never, recon: v!.spec as never };
    const ctx = (amount: string) => ({ "break.amount": amount, "break.currency": "IDR", "break.reason": "No counterpart" });
    await withSpace({ spaceIds: [A], userId: null }, async (tx) => {
      await joinGroup(tx, target, { requestId: Bun.randomUUIDv7(), itemId: I.a1, context: ctx("10000") });
      await joinGroup(tx, target, { requestId: Bun.randomUUIDv7(), itemId: I.a2, context: ctx("-13000") });
    });
    expect((await groups()).map((g) => [g.negative, g.totalMinor]).sort()).toEqual([[false, 10_000n], [true, -13_000n]]);
    await close();
    expect((await payloads()).map((p) => p.Amount).sort()).toEqual([10000, 13000]);
  });

  it("a group that can't be built writes a failed run; the other groups and the day close go on", async () => {
    const one = grouped({ key: ["side_a.ext_ref"] });
    await setup(one);
    for (const id of [I.a1, I.b2]) { await ask(id); await approve(id); }
    // one group pins an older version whose variant can't be built (a template that isn't text)
    const [v] = await db.select().from(reconConfigVersions).where(and(eq(reconConfigVersions.configId, cfg), eq(reconConfigVersions.status, "published")));
    const sp = structuredClone(v!.spec) as { approvals: { changes: { write_off: { actions: { variants: unknown[] }[] } } } };
    sp.approvals.changes.write_off.actions[0]!.variants = [{ ...one, mapping: { Amount: { kind: "template", text: 5 }, Remark: { kind: "const", value: "x" } } }];
    const old = Bun.randomUUIDv7();
    await db.insert(reconConfigVersions).values({ ...v!, id: old, version: 99, status: "retired", spec: sp });
    const [g1] = await groups();
    await db.update(postingGroups).set({ configVersionId: old }).where(eq(postingGroups.id, g1!.id));
    expect(await closeDay(db, { spaceId: A, configId: cfg }, today(), new Date(Date.now() + 3 * 86_400_000))).not.toBe("not_due");
    const runs = await db.select().from(actionRuns);
    expect(runs.map((r) => [r.groupId === g1!.id, r.status, r.code]).sort()).toEqual([[false, "queued", null], [true, "failed", "build_error"]]);
    expect((await groups()).map((g) => g.status)).toEqual(["closed", "closed"]);
    expect(await db.select({ d: reconDays.businessDate }).from(reconDays)).toEqual([{ d: today() }]);
  });

  it("a group run that ends as it is written (a failed build) queues its breaks' dashboard rollup (I1)", async () => {
    const one = grouped({ key: ["side_a.ext_ref"] });
    await setup(one);
    await ask(I.a1); await approve(I.a1);
    const [v] = await db.select().from(reconConfigVersions).where(and(eq(reconConfigVersions.configId, cfg), eq(reconConfigVersions.status, "published")));
    const sp = structuredClone(v!.spec) as { approvals: { changes: { write_off: { actions: { variants: unknown[] }[] } } } };
    sp.approvals.changes.write_off.actions[0]!.variants = [{ ...one, mapping: { Amount: { kind: "template", text: 5 }, Remark: { kind: "const", value: "x" } } }];
    const old = Bun.randomUUIDv7();
    await db.insert(reconConfigVersions).values({ ...v!, id: old, version: 99, status: "retired", spec: sp });
    const [g] = await groups();
    await db.update(postingGroups).set({ configVersionId: old }).where(eq(postingGroups.id, g!.id));
    await (await boss()).deleteAllJobs();
    expect(await withSpace({ spaceIds: [A], userId: null }, (tx) => closeGroup(tx, A, g!.id))).toBe("sent");
    expect((await db.select({ s: actionRuns.status }).from(actionRuns)).map((r) => r.s)).toEqual(["failed"]);
    expect((await (await boss()).findJobs(QUEUES.reconStats, { key: `${cfg}:${D}` })).length).toBe(1);
  });

  it("a grouped variant on a notify action sends one call per item, it joins no group", async () => {
    await setup(grouped({}), { kind: "notify" });
    await ask(I.a1); await approve(I.a1);
    expect(await groups()).toEqual([]);
    expect(await db.select({ itemId: actionRuns.itemId }).from(actionRuns)).toEqual([{ itemId: I.a1 }]);
  });

  it("a member's values are kept encrypted; the posting list finds a group's run by its key and the CSV names the group", async () => {
    await setup(grouped({}));
    await ask(I.a1); await approve(I.a1);
    const [m] = await members();
    expect(m!.context).toBeNull();
    expect(JSON.parse(decryptSecret(m!.contextEnc!))["break.reference"]).toBe("P1");
    await close();
    const found = await json<{ total: number }>(call("GET", `/v1/spaces/${A}/action-runs?show=all&q=counterpart`, { token: t.op }));
    expect(found.total).toBe(1);
    const csv = await (await call("GET", `/v1/spaces/${A}/action-runs?show=all&format=csv`, { token: t.op })).text();
    expect(csv).toContain(`Group ${today()} · Break reason No counterpart`);
  });
});
