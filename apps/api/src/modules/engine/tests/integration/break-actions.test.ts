// Approval actions written to the outbox with the decision (stage 4, design §4.6): per event (a level approved, the
// final approval, a reject, an override's skipped levels in order), per item or per request, the variant that fits,
// the payload built (encrypted while queued) or why not (no posting rule, build error); once per event, whatever is
// clicked twice; from the request's own recon version.
import { beforeEach, describe, expect, it } from "bun:test";
import type { BreakDetailDto } from "@starterkit/shared/contracts/breaks";
import type { SpaceRole } from "@starterkit/shared/spaces";
import { and, asc, eq } from "drizzle-orm";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { decryptSecret } from "../../../../kernel/crypto";
import { db } from "../../../../kernel/db";
import { ensureMonthPartitions } from "../../../../kernel/partitions";
import { workflows, workflowVersions } from "../../../approvals";
import { records } from "../../../ingest";
import { actionRuns, connectors, connectorVersions } from "../../../integrations";
import { reconConfigVersions } from "../../../recon";
import { spaceMembers, spaces } from "../../../spaces";
import { users } from "../../../users";
import { reconItems } from "../../schema";
import { D, makeSource, plainSource, put, recon, spec } from "../fixtures";

const idOf = async (username: string) => (await db.select({ id: users.id }).from(users).where(eq(users.username, username)))[0]!.id;
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
let A: string, cfg: string, cid: string;
let t: Record<"op" | "rev" | "adm" | "sa", string>;
let I: Record<"a1" | "b1" | "b2", string>;
const env = { baseUrl: "", host: "", partnerId: "", channelId: "", verifyTls: false };
const OP = { key: "post", name: "Post", method: "POST", path: "/post", timeoutMs: 30000,
  request: [{ name: "Amount", type: "numeric", required: true }, { name: "Remark", type: "string", required: true }, { name: "Note", type: "string", required: false }],
  response: [], success: null, reference: null, masked: [], presets: {}, auto: {} };
const group = (o: object) => ({ spaceRoles: [], globalRoles: [], users: [], need: { kind: "any" }, ...o });
const variant = (o: object = {}) => ({ name: "Default", when: null, operation: { connectorId: cid, version: 1, key: "post" }, per: "item", zeroOrNegative: "skip",
  mapping: { Amount: { kind: "field", key: "break.amount", transforms: [] }, Remark: { kind: "template", text: "{side_a.ext_ref}{side_b.ext_ref}-{approval.level}" } }, ...o });

/** The recon's published version: a 2-level workflow for `kind` and these actions. */
async function setup(kind: string, actions: unknown[], levels = 2) {
  const w = Bun.randomUUIDv7();
  const chain = [{ name: "Review", groups: [group({ spaceRoles: ["reviewer"] })] }, { name: "Head", groups: [group({ spaceRoles: ["space_admin"] })] }, { name: "Third", groups: [group({ spaceRoles: ["reviewer", "space_admin"] })] }].slice(0, levels);
  await db.insert(workflows).values({ id: w, spaceId: A, name: "Two levels" });
  await db.insert(workflowVersions).values({ id: Bun.randomUUIDv7(), spaceId: A, workflowId: w, version: 1, status: "published", spec: { name: "Two levels", levels: chain } });
  const [v] = await db.select().from(reconConfigVersions).where(and(eq(reconConfigVersions.configId, cfg), eq(reconConfigVersions.status, "published")));
  await db.update(reconConfigVersions).set({ spec: { ...(v!.spec as object), approvals: { accounts: [], lookups: [], changes: { [kind]: { workflow: { default: { id: w, version: 1 }, rules: [] }, actions } } } } }).where(eq(reconConfigVersions.id, v!.id));
}
const runs = () => db.select().from(actionRuns).orderBy(asc(actionRuns.seq));
const detail = (id: string, token = t.op) => json<BreakDetailDto>(call("GET", `/v1/spaces/${A}/breaks/${id}`, { token }));
const decide = async (id: string, how: "approve" | "reject" | "override", b: unknown, token: string) =>
  call("POST", `/v1/spaces/${A}/approval-requests/${(await detail(id, token)).request!.id}/${how}`, { token, body: b });

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
  const [ra] = await put(sa, [{ ref: "P1", amount: 10_000n }]);
  const [rb1, rb2] = await put(sb, [{ ref: "Q1", amount: 10_000n }, { ref: "Q2", amount: 9_900n }]);
  cfg = (await recon(A, spec(sa.sourceId, sb.sourceId, [{ no: 1, name: "Exact", cardinality: "1:1", blocking: ["ext_ref"], accept: "auto", on_ambiguous: "break", predicates: [{ op: "eq", field: "amount_minor" }] }]))).configId;
  const item = (side: "a" | "b", recordId: string, status: string, reason: string | null) => ({ id: Bun.randomUUIDv7(), spaceId: A, configId: cfg, recordId, side, status, businessDate: D, breakReason: reason });
  const rows = { a1: item("a", ra!, "break", "No counterpart"), b1: item("b", rb1!, "open", null), b2: item("b", rb2!, "break", "No counterpart") };
  await db.insert(reconItems).values(Object.values(rows));
  I = { a1: rows.a1.id, b1: rows.b1.id, b2: rows.b2.id };
  cid = Bun.randomUUIDv7();
  await db.insert(connectors).values({ id: cid, name: "Bank Mega" });
  await db.insert(connectorVersions).values({ id: Bun.randomUUIDv7(), connectorId: cid, version: 1, status: "published", spec: { name: "Bank Mega", profile: "bank_mega_openapi_2_1", active: "dev", environments: { dev: env, prod: env }, operations: [OP] } });
  t = { op: await signIn("viewer"), rev: await signIn("google"), adm: await signIn("admin"), sa: await signIn("superadmin") };
  await call("POST", `/v1/spaces/${A}/breaks/take`, { token: t.op, body: { ids: [I.a1] } });
});

describe("actions written with the decision", () => {
  it("level 1 fires only its own actions; the final approval fires the approved ones; the payload is encrypted while queued", async () => {
    await setup("write_off", [
      { name: "Status", kind: "notify", on: { event: "level_approved", level: 1 }, variants: [variant()] },
      { name: "Post", kind: "posting", on: { event: "approved" }, variants: [variant()] },
    ]);
    await call("POST", `/v1/spaces/${A}/breaks/${I.a1}/request`, { token: t.op, body: { kind: "write_off", note: "Stale" } });
    await decide(I.a1, "approve", {}, t.rev);
    let r = await runs();
    expect(r.map((x) => [x.actionName, x.event, x.level, x.status])).toEqual([["Status", "level_approved", 1, "queued"]]);
    expect(JSON.parse(decryptSecret(r[0]!.payloadEnc!))).toEqual({ Amount: 10000, Remark: "P1-1" });
    await decide(I.a1, "approve", {}, t.adm);
    r = await runs();
    expect(r.map((x) => [x.actionName, x.event, x.status, x.seq])).toEqual([["Status", "level_approved", "queued", 1], ["Post", "approved", "queued", 2]]);
    expect(JSON.parse(decryptSecret(r[1]!.payloadEnc!))).toEqual({ Amount: 10000, Remark: "P1-2" });
  });

  it("Approve clicked twice at once writes each run once", async () => {
    await setup("write_off", [{ name: "Post", kind: "posting", on: { event: "approved" }, variants: [variant()] }], 1);
    await call("POST", `/v1/spaces/${A}/breaks/${I.a1}/request`, { token: t.op, body: { kind: "write_off", note: "Stale" } });
    const id = (await detail(I.a1, t.rev)).request!.id;
    await Promise.all([1, 2].map(() => call("POST", `/v1/spaces/${A}/approval-requests/${id}/approve`, { token: t.rev, body: {} })));
    expect((await runs()).map((x) => x.actionName)).toEqual(["Post"]);
  });

  it("a reject fires the rejected actions only", async () => {
    await setup("write_off", [
      { name: "Post", kind: "posting", on: { event: "approved" }, variants: [variant()] },
      { name: "Tell", kind: "notify", on: { event: "rejected" }, variants: [variant()] },
    ]);
    await call("POST", `/v1/spaces/${A}/breaks/${I.a1}/request`, { token: t.op, body: { kind: "write_off", note: "Stale" } });
    await decide(I.a1, "reject", { note: "Not yet" }, t.rev);
    expect((await runs()).map((x) => [x.actionName, x.event])).toEqual([["Tell", "rejected"]]);
  });

  it("an override fires the skipped levels in order, then approved, all marked override", async () => {
    await setup("write_off", [
      { name: "L1", kind: "notify", on: { event: "level_approved", level: 1 }, variants: [variant()] },
      { name: "L3", kind: "notify", on: { event: "level_approved", level: 3 }, variants: [variant()] },
      { name: "Post", kind: "posting", on: { event: "approved" }, variants: [variant()] },
    ], 3);
    await call("POST", `/v1/spaces/${A}/breaks/${I.a1}/request`, { token: t.op, body: { kind: "write_off", note: "Stale" } });
    await decide(I.a1, "override", { reason: "Month end" }, t.sa);
    expect((await runs()).map((x) => [x.actionName, x.level, x.override, x.seq])).toEqual([["L1", 1, true, 1], ["L3", 3, true, 2], ["Post", null, true, 3]]);
  });

  it("no variant fits → no posting rule; a required field empty → failed, naming it; neither is sent", async () => {
    await setup("write_off", [
      { name: "Only RTGS", kind: "posting", on: { event: "approved" }, variants: [variant({ when: { all: [{ field: "side_a.attrs.channel", op: "eq", value: "RTGS" }] } })] },
      { name: "Broken", kind: "posting", on: { event: "approved" }, variants: [variant({ mapping: { Amount: { kind: "field", key: "break.amount", transforms: [] } } })] },
    ], 1);
    await call("POST", `/v1/spaces/${A}/breaks/${I.a1}/request`, { token: t.op, body: { kind: "write_off", note: "Stale" } });
    await decide(I.a1, "approve", {}, t.rev);
    expect((await runs()).map((x) => [x.actionName, x.status, x.code, x.message, x.payloadEnc])).toEqual([
      ["Only RTGS", "no_rule", null, "No posting rule fits this break.", null],
      ["Broken", "failed", "build_error", "Remark is required, and this break has no value for it.", null],
    ]);
  });

  it("a force match per item: one run per break, each from its own side; per request: one", async () => {
    await setup("force_match", [
      { name: "Each", kind: "posting", on: { event: "approved" }, variants: [variant()] },
      { name: "Once", kind: "posting", on: { event: "approved" }, variants: [variant({ per: "request" })] },
    ], 1);
    await call("POST", `/v1/spaces/${A}/breaks/${I.a1}/request`, { token: t.op, body: { kind: "force_match", itemIds: [I.b2], note: "Fee" } });
    await decide(I.a1, "approve", {}, t.rev);
    const r = await runs();
    expect(r.map((x) => [x.actionName, x.itemId])).toEqual([["Each", I.a1], ["Each", I.b2], ["Once", null]]);
    expect(r.map((x) => JSON.parse(decryptSecret(x.payloadEnc!)).Remark)).toEqual(["P1Q2-1", "P1Q2-1", "P1Q2-1"]);
  });

  it("a request keeps the actions of the recon version it was opened under", async () => {
    await setup("write_off", [{ name: "Old", kind: "posting", on: { event: "approved" }, variants: [variant()] }], 1);
    await call("POST", `/v1/spaces/${A}/breaks/${I.a1}/request`, { token: t.op, body: { kind: "write_off", note: "Stale" } });
    // the live version changes its actions meanwhile (as a newer published version would)
    const [v] = await db.select().from(reconConfigVersions).where(eq(reconConfigVersions.configId, cfg));
    const s = v!.spec as { approvals: { changes: { write_off: { actions: { name: string }[] } } } };
    const old = structuredClone(s);
    s.approvals.changes.write_off.actions[0]!.name = "New";
    const newer = Bun.randomUUIDv7();
    await db.update(reconConfigVersions).set({ status: "retired", spec: old }).where(eq(reconConfigVersions.id, v!.id));
    await db.insert(reconConfigVersions).values({ ...v!, id: newer, version: 2, status: "published", spec: s });
    await decide(I.a1, "approve", {}, t.rev);
    expect((await runs()).map((x) => x.actionName)).toEqual(["Old"]);
  });
});

describe("the posting result on the break (read side)", () => {
  it("shows its actions and the last posting; the payload only to the space admin or an Open API reader", async () => {
    await setup("write_off", [
      { name: "Tell", kind: "notify", on: { event: "approved" }, variants: [variant()] },
      { name: "Post", kind: "posting", on: { event: "approved" }, variants: [variant()] },
    ], 1);
    await call("POST", `/v1/spaces/${A}/breaks/${I.a1}/request`, { token: t.op, body: { kind: "write_off", note: "Stale" } });
    await decide(I.a1, "approve", {}, t.rev);
    await db.update(actionRuns).set({ status: "posted", bankReference: "R1", payloadEnc: null, payloadMasked: { Amount: 10000 }, finishedAt: new Date() }).where(eq(actionRuns.actionName, "Post"));
    const op = await detail(I.a1, t.op);
    expect(op.posting).toMatchObject({ status: "posted", bankReference: "R1", action: "Post" });
    expect(op.actions.map((a) => [a.name, a.kind, a.status, a.payload])).toEqual([["Tell", "notify", "queued", null], ["Post", "posting", "posted", null]]);
    const adm = await detail(I.a1, t.adm);
    expect(adm.actions[1]!.payload).toEqual({ Amount: 10000 });
  });

  it("a break with no actions has no posting", async () => {
    expect((await detail(I.a1, t.op)).posting).toBeNull();
  });
});

describe("posting results of the space", () => {
  it("lists runs newest first with their break and recon; filters by status and kind; any role of the space reads", async () => {
    await setup("write_off", [
      { name: "Tell", kind: "notify", on: { event: "approved" }, variants: [variant()] },
      { name: "Post", kind: "posting", on: { event: "approved" }, variants: [variant()] },
    ], 1);
    await call("POST", `/v1/spaces/${A}/breaks/${I.a1}/request`, { token: t.op, body: { kind: "write_off", note: "Stale" } });
    await decide(I.a1, "approve", {}, t.rev);
    await db.update(actionRuns).set({ status: "failed", code: "51", message: "The bank answered 51." }).where(eq(actionRuns.actionName, "Post"));
    const page = await json<{ items: { action: string; status: string; break: { id: string; ref: string | null }; recon: { name: string }; code: string | null }[]; total: number }>(
      call("GET", `/v1/spaces/${A}/action-runs?status=failed&kind=posting`, { token: t.op }));
    expect(page.items.map((r) => [r.action, r.status, r.break.ref, r.recon.name, r.code])).toEqual([["Post", "failed", "P1", "R", "51"]]);
    expect((await json<{ total: number }>(call("GET", `/v1/spaces/${A}/action-runs`, { token: t.op }))).total).toBe(2);
    expect((await json<{ total: number }>(call("GET", `/v1/spaces/${A}/action-runs?q=P1`, { token: t.op }))).total).toBe(2);
    const csv = await call("GET", `/v1/spaces/${A}/action-runs?status=failed&format=csv`, { token: t.op });
    expect(csv.headers.get("content-disposition")).toMatch(/attachment; filename="posting-\d{4}-\d{2}-\d{2}\.csv"/);
    const lines = (await csv.text()).replace(/^\uFEFF/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Time (UTC),Recon,Break,Action,Event,Status,Code,Message,Bank reference,External ID");
    expect(lines.slice(1).map((l) => l.split(",").slice(1, 7))).toEqual([["R", "P1", "Post", "Approved", "Failed", "51"]]);
  });

  it("Today counts each recon's runs of the last 24 hours that need someone: failed, timeout, not sent", async () => {
    await setup("write_off", [{ name: "Post", kind: "posting", on: { event: "approved" }, variants: [variant()] }], 1);
    await call("POST", `/v1/spaces/${A}/breaks/${I.a1}/request`, { token: t.op, body: { kind: "write_off", note: "Stale" } });
    await decide(I.a1, "approve", {}, t.rev);
    const today = async () => (await json<{ posting: { reconId: string; failed: number; timeout: number; notSent: number }[] }>(call("GET", `/v1/spaces/${A}/today`, { token: t.op }))).posting;
    expect(await today()).toEqual([]);
    await db.update(actionRuns).set({ status: "timeout" });
    expect(await today()).toEqual([{ reconId: cfg, failed: 0, timeout: 1, notSent: 0 }]);
    await db.update(actionRuns).set({ createdAt: new Date(Date.now() - 25 * 3_600_000) });
    expect(await today()).toEqual([]);
  });
});

describe("what gets posted (preview)", () => {
  it("picks the variant for a real break and shows the payload, masked, with each field's source; or why not", async () => {
    await setup("write_off", [{ name: "Post", kind: "posting", on: { event: "approved" }, variants: [
      variant({ name: "Big", when: { all: [{ field: "break.amount", op: "gte", value: "999999999" }] } }),
      variant({ name: "Default", mapping: { ...variant().mapping, Note: { kind: "const", value: "fixed" } } }),
    ] }], 1);
    const [v] = await db.select({ id: reconConfigVersions.id }).from(reconConfigVersions).where(eq(reconConfigVersions.configId, cfg));
    const at = `/v1/spaces/${A}/recons/${cfg}/versions/${v!.id}/actions/preview`;
    const p = await json<{ variant: string | null; payload: unknown; sources: Record<string, string>; problem: { code: string; field: string; message: string } | null }>(
      call("POST", at, { token: t.op, body: { change: "write_off", action: 0, itemId: I.a1 } }));
    expect(p).toEqual({ variant: "Default", payload: { Amount: 10000, Remark: "P1-1", Note: "fixed" }, sources: { Amount: "break.amount", Remark: "template", Note: "fixed" }, problem: null });
    const none = await json<{ variant: string | null; problem: { message: string } | null }>(call("POST", at, { token: t.op, body: { change: "unmatch", action: 0, itemId: I.a1 } }));
    expect(none).toMatchObject({ variant: null, problem: { message: "This change has no such action." } });
  });
});

describe("operations a recon may pick", () => {
  it("any role of the space reads the published connector versions' operations, never their settings or secrets", async () => {
    const r = await call("GET", `/v1/spaces/${A}/connector-operations`, { token: t.op });
    const text = await r.text();
    const body = JSON.parse(text) as { items: { id: string; name: string; versions: { version: number; live: boolean; operations: { key: string; name: string; request: unknown[]; fixed: string[]; auto: string[] }[] }[] }[] };
    expect(body.items as unknown[]).toEqual([{ id: cid, name: "Bank Mega", disabled: false, versions: [{ version: 1, live: true, operations: [{ key: "post", name: "Post", method: "POST", path: "/post", request: OP.request, fixed: [], auto: [] }] }] }]);
    expect(text).not.toContain("baseUrl");
  });
});
