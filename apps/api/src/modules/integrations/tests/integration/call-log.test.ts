// The connector call log (spec 2026-11-24-connector-call-log-design): every outbound call is one row written by the
// transport after the call, with the caller's origin and actor; a call that never left is a not-sent row; no row, no
// full call and no activity entry holds the client secret, the Basic credential or a whole access token.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { ConnectorDetailDto } from "@starterkit/shared/contracts/integrations";
import { asc, eq } from "drizzle-orm";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { type FakeBank, fakeBank } from "../../../../../test/helpers/fake-bank";
import { decryptSecret, encryptSecret } from "../../../../kernel/crypto";
import { db } from "../../../../kernel/db";
import { activity } from "../../../audit";
import { approvalDecisions, approvalRequests } from "../../../approvals";
import { reconConfigs } from "../../../recon";
import { spaces } from "../../../spaces";
import { users } from "../../../users";
import { callsLogged } from "../../call-log";
import { actionRuns, connectorCalls, connectors, connectorSecrets, connectorTokens, connectorVersions } from "../../schema";
import { sendRun } from "../../worker";

const C = "/v1/integrations/connectors";
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
let bank: FakeBank, t: string, adminId: string;
const op = { key: "post", name: "Post to GL", method: "POST", path: "/ok?b=2&a=1", timeoutMs: 5000, request: [{ name: "Amount", type: "string", required: true }, { name: "Account", type: "string", required: false }],
  response: [{ name: "ResponseCode", type: "string", required: false }, { name: "Ref", type: "string", required: false }, { name: "Account", type: "string", required: false }],
  success: { field: "ResponseCode", equals: "00" }, reference: "Ref", masked: ["Account"], presets: {}, auto: {} };

/** A connector through the API (draft, dev and prod secrets), as the Try panel and Check token use it. */
async function apiConnector(o: { url?: string; secret?: string } = {}) {
  const env = { baseUrl: o.url ?? bank.url, host: "localhost", partnerId: "P1", channelId: "C1", verifyTls: false };
  const c = await json<ConnectorDetailDto>(call("POST", C, { token: t, body: { spec: { name: `Bank ${Bun.randomUUIDv7().slice(-6)}`, profile: "bank_mega_openapi_2_1", active: "dev", environments: { dev: env, prod: env }, operations: [op] } } }));
  await call("PUT", `${C}/${c.id}/secrets`, { token: t, body: { environment: "dev", clientId: bank.clientId, clientSecret: o.secret ?? bank.clientSecret, publicKey: bank.publicKey } });
  return c.id;
}
const rows = async () => { await callsLogged(); return db.select().from(connectorCalls).orderBy(asc(connectorCalls.startedAt), asc(connectorCalls.id)); };
/** Everything stored about the calls, the full calls decrypted, as one text. */
const stored = async () => (await rows()).map((r) => JSON.stringify(r) + (r.fullEnc ? decryptSecret(r.fullEnc) : "")).join("\n");
const basic = () => Buffer.from(`${bank.clientId}:${bank.clientSecret}`).toString("base64");

beforeAll(() => { bank = fakeBank(); });
afterAll(() => bank.stop());
beforeEach(async () => {
  await resetData();
  await db.delete(spaces);
  await db.delete(connectors);
  t = await signIn("admin");
  adminId = (await db.select({ id: users.id }).from(users).where(eq(users.username, "admin")))[0]!.id;
});

describe("the transport writes one row per call", () => {
  it("Try: a token row and an operation row, origin integrations/try, actor the user, the version tried", async () => {
    const id = await apiConnector();
    await call("POST", `${C}/${id}/try`, { token: t, body: { operation: "post", body: { Amount: "150000", Account: "1234567890" } } });
    const [token, sent] = await rows();
    expect(token).toMatchObject({ connectorId: id, connectorVersion: 1, environment: "dev", operationKey: null, method: "POST", path: "/realms/bpsecurity/protocol/openid-connect/token", outcome: "ok", httpStatus: 200, attempt: 1, actorId: adminId });
    expect(sent).toMatchObject({ operationKey: "post", method: "POST", path: "/ok", outcome: "ok", httpStatus: 200, code: "00", attempt: 1, actorId: adminId, onBehalfOf: null });
    expect(sent!.host).toMatch(/^localhost:\d+$/);
    expect(sent!.origin).toEqual({ module: "integrations", kind: "try", refId: id, label: "Post to GL", href: `/integrations/${id}` });
    expect(token!.origin).toEqual(sent!.origin);
    expect(sent!.externalId).toMatch(/^\d{20}$/);
    expect(sent!.requestMasked).toEqual({ Amount: "150000", Account: "12******90" });
    expect((sent!.responseMasked as { Account: string }).Account).toBe("12******90");
    // the full call: headers as sent (the bearer's last 8 only), the plain and the sealed body, the answer raw and decrypted
    const full = JSON.parse(decryptSecret(sent!.fullEnc!)) as { request: { url: string; headers: Record<string, string>; json: string; body: string }; response: { status: number; headers: Record<string, string>; raw: string; json: { Account: string } } };
    expect(full.request.headers.Authorization).toMatch(/^Bearer ….{8}$/);
    expect(Object.keys(full.request.headers)).toEqual(expect.arrayContaining(["X-SIGNATURE", "X-TIMESTAMP", "X-EXTERNAL-ID", "X-PARTNER-ID", "CHANNEL-ID", "X-CREDENTIAL-KEY"]));
    expect(JSON.parse(full.request.json)).toEqual({ Amount: "150000", Account: "1234567890" });
    expect(full.request.body).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(full.request.url).toEndWith("/ok?b=2&a=1");
    expect(full.response.status).toBe(200);
    expect(full.response.json.Account).toBe("1234567890");
    expect(full.response.raw).toMatch(/^[A-Za-z0-9+/]+=*$/);
    // the token call: a hidden Basic credential, the token's last 8
    const tf = JSON.parse(decryptSecret(token!.fullEnc!)) as { request: { headers: Record<string, string> }; response: { json: { access_token: string } } };
    expect(tf.request.headers.Authorization).toBe("Basic (hidden)");
    expect(tf.response.json.access_token).toMatch(/^….{8}$/);
    expect((token!.responseMasked as { access_token: string }).access_token).toMatch(/^….{8}$/);
  });

  it("a cached token makes no token call: the second Try writes one row", async () => {
    const id = await apiConnector();
    for (let i = 0; i < 2; i++) await call("POST", `${C}/${id}/try`, { token: t, body: { operation: "post", body: { Amount: "1" } } });
    expect((await rows()).map((r) => r.operationKey)).toEqual([null, "post", "post"]);
  });

  it("Check token: one token row, origin integrations/token_check, actor the user", async () => {
    const id = await apiConnector();
    await call("POST", `${C}/${id}/token-check`, { token: t, body: { environment: "dev" } });
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ operationKey: null, outcome: "ok", actorId: adminId, connectorVersion: 1 });
    expect(all[0]!.origin).toEqual({ module: "integrations", kind: "token_check", refId: id, label: "Check token", href: `/integrations/${id}` });
  });

  it("a call that never left (no address) is a not-sent row", async () => {
    const id = await apiConnector({ url: "" });
    await call("POST", `${C}/${id}/try`, { token: t, body: { operation: "post", body: { Amount: "1" } } });
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ operationKey: "post", outcome: "not_sent", httpStatus: null, message: "Enter this environment's address first.", host: "", path: "/ok" });
  });

  it("refused credentials: the token row is rejected, the operation not sent; no secret, Basic credential or whole token is stored", async () => {
    const id = await apiConnector({ secret: "wrong-secret-value" });
    await call("POST", `${C}/${id}/try`, { token: t, body: { operation: "post", body: { Amount: "1" } } });
    const all = await rows();
    expect(all.map((r) => [r.operationKey, r.outcome, r.httpStatus])).toEqual([[null, "rejected", 401], ["post", "not_sent", null]]);
    const text = await stored();
    expect(text).not.toContain("wrong-secret-value");
    expect(text).not.toContain(Buffer.from(`${bank.clientId}:wrong-secret-value`).toString("base64"));
  });

  it("no row, full call or activity entry holds the client secret, the Basic credential or the whole token", async () => {
    const id = await apiConnector();
    await call("POST", `${C}/${id}/try`, { token: t, body: { operation: "post", body: { Amount: "1" } } });
    await call("POST", `${C}/${id}/token-check`, { token: t, body: { environment: "dev" } });
    const [cached] = await db.select().from(connectorTokens).where(eq(connectorTokens.connectorId, id));
    const whole = decryptSecret(cached!.tokenEnc);
    const text = await stored() + JSON.stringify(await db.select().from(activity));
    for (const secret of [bank.clientSecret, basic(), whole]) expect(text).not.toContain(secret);
    expect(text).toContain(whole.slice(-8));
  });
});

describe("the worker's sends", () => {
  it("a run's call: origin approvals/action with the run, attempt, on behalf of the approver, System as actor", async () => {
    const A = Bun.randomUUIDv7(), cfg = Bun.randomUUIDv7(), rq = Bun.randomUUIDv7(), item = Bun.randomUUIDv7();
    await db.insert(spaces).values({ id: A, code: "treasury", name: "Treasury" });
    await db.insert(reconConfigs).values({ id: cfg, spaceId: A, code: "r1", name: "R1" });
    await db.insert(approvalRequests).values({ id: rq, spaceId: A, configId: cfg, kind: "write_off", itemId: item, label: "P1-2", note: "x", status: "approved" });
    await db.insert(approvalDecisions).values({ id: Bun.randomUUIDv7(), spaceId: A, requestId: rq, level: 0, userId: adminId, decision: "approve" });
    const cid = Bun.randomUUIDv7();
    const env = { baseUrl: bank.url, host: "localhost", partnerId: "P1", channelId: "C1", verifyTls: false };
    await db.insert(connectors).values({ id: cid, name: "Bank" });
    await db.insert(connectorVersions).values({ id: Bun.randomUUIDv7(), connectorId: cid, version: 3, status: "published", spec: { name: "Bank", profile: "bank_mega_openapi_2_1", active: "dev", environments: { dev: env, prod: env }, operations: [op] } });
    await db.insert(connectorSecrets).values({ connectorId: cid, environment: "dev", secretEnc: encryptSecret(JSON.stringify({ clientId: bank.clientId, clientSecret: bank.clientSecret, publicKey: bank.publicKey })) });
    const run = (n: number, status = "queued") => ({
      id: Bun.randomUUIDv7(), spaceId: A, requestId: rq, configVersionId: Bun.randomUUIDv7(), actionIndex: n, actionName: "Post to GL", kind: "posting", event: "approved", itemId: item, subjectRef: "P1-2",
      seq: n + 1, connectorId: cid, connectorVersion: 3, operationKey: "post", status, payloadEnc: encryptSecret(JSON.stringify({ Amount: "1" })), createdAt: new Date(Date.now() - (5 - n) * 1000),
    });
    // an earlier send of the same action for the same item failed: this run is attempt 2
    const first = run(0, "failed"), second = run(1);
    await db.insert(actionRuns).values([first, second]);
    expect(await sendRun(db, A, second.id)).toBe("sent");
    const all = await rows();
    expect(all.map((r) => r.operationKey)).toEqual([null, "post"]);
    for (const r of all) {
      expect(r).toMatchObject({ actorId: null, onBehalfOf: adminId, attempt: 2, connectorVersion: 3, environment: "dev" });
      expect(r.origin).toEqual({ module: "approvals", kind: "action", refId: second.id, label: "Post to GL · P1-2", href: `/spaces/${A}/posting?q=P1-2&show=all` });
    }
  });
});
