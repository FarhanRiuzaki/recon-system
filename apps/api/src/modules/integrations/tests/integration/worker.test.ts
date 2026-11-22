// The action worker (stage 4, design §4.6.3–4): a queued run is taken once (queued → sending), waits for the runs of
// its request before it, is sent through the security profile and finished as posted / failed / not_sent / timeout;
// the payload is kept masked only; 5 transport failures in a row pause calls for 60 s; a sending run left by a dead
// worker becomes timeout and is never sent again.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { resetData } from "../../../../../test/helpers/app";
import { type FakeBank, fakeBank } from "../../../../../test/helpers/fake-bank";
import { encryptSecret } from "../../../../kernel/crypto";
import { db } from "../../../../kernel/db";
import { spaces } from "../../../spaces";
import { actionRuns, connectors, connectorSecrets, connectorVersions } from "../../schema";
import { sendRun, sweepStale } from "../../worker";

let bank: FakeBank, A: string;
const op = { key: "post", name: "Post", method: "POST", path: "/ok", timeoutMs: 5000, request: [{ name: "Amount", type: "string", required: true }],
  response: [{ name: "ResponseCode", type: "string", required: false }, { name: "Ref", type: "string", required: false }, { name: "Account", type: "string", required: false }],
  success: { field: "ResponseCode", equals: "00" }, reference: "Ref", masked: ["Account"], presets: {}, auto: {} };

async function connector(url = bank.url) {
  const id = Bun.randomUUIDv7();
  const env = { baseUrl: url, host: "localhost", partnerId: "P1", channelId: "C1", verifyTls: false };
  await db.insert(connectors).values({ id, name: `Bank ${id.slice(-6)}` });
  await db.insert(connectorVersions).values({ id: Bun.randomUUIDv7(), connectorId: id, version: 1, status: "published", spec: { name: "Bank", profile: "bank_mega_openapi_2_1", active: "dev", environments: { dev: env, prod: env }, operations: [op] } });
  await db.insert(connectorSecrets).values({ connectorId: id, environment: "dev", secretEnc: encryptSecret(JSON.stringify({ clientId: bank.clientId, clientSecret: bank.clientSecret, publicKey: bank.publicKey })) });
  return id;
}
async function run(connectorId: string, o: { seq?: number; requestId?: string; body?: object } = {}) {
  const id = Bun.randomUUIDv7();
  await db.insert(actionRuns).values({
    id, spaceId: A, requestId: o.requestId ?? Bun.randomUUIDv7(), configVersionId: Bun.randomUUIDv7(), actionIndex: (o.seq ?? 1) - 1, actionName: "Post", kind: "posting", event: "approved",
    seq: o.seq ?? 1, connectorId, connectorVersion: 1, operationKey: "post", status: "queued", payloadEnc: encryptSecret(JSON.stringify(o.body ?? { Amount: "150000" })),
  });
  return id;
}
const row = async (id: string) => (await db.select().from(actionRuns).where(eq(actionRuns.id, id)))[0]!;

beforeAll(() => { bank = fakeBank(); });
afterAll(() => bank.stop());
beforeEach(async () => {
  await resetData();
  await db.delete(spaces);
  await db.delete(connectors);
  A = Bun.randomUUIDv7();
  await db.insert(spaces).values({ id: A, code: "treasury", name: "Treasury" });
});

describe("the action worker", () => {
  it("posts a run: the success rule, the bank's reference, the answer masked, the payload kept masked only", async () => {
    const r = await run(await connector());
    expect(await sendRun(db, A, r)).toBe("sent");
    const x = await row(r);
    expect(x).toMatchObject({ status: "posted", bankReference: "R1", httpStatus: 200, payloadEnc: null, code: "00" });
    expect((x.responseMasked as { Account: string }).Account).toBe("12******90");
    expect(x.payloadMasked).toEqual({ Amount: "150000" });
    expect(x.externalId).toMatch(/^\d{20}$/);
  });

  it("two workers on one run make one call", async () => {
    const r = await run(await connector());
    const calls = bank.calls.length;
    const got = await Promise.all([sendRun(db, A, r), sendRun(db, A, r)]);
    expect(got.sort()).toEqual(["sent", "skip"]);
    expect(bank.calls.length - calls).toBe(1);
  });

  it("a run waits while an earlier run of its request isn't finished", async () => {
    const c = await connector(), rq = Bun.randomUUIDv7();
    const first = await run(c, { requestId: rq, seq: 1 }), second = await run(c, { requestId: rq, seq: 2 });
    expect(await sendRun(db, A, second)).toBe("waiting");
    expect((await row(second)).status).toBe("queued");
    await sendRun(db, A, first);
    expect(await sendRun(db, A, second)).toBe("sent");
  });

  it("a bank answer that isn't success fails with the bank's code", async () => {
    const r = await run(await connector(), { body: { Amount: "1", fail: true } });
    await sendRun(db, A, r);
    expect(await row(r)).toMatchObject({ status: "failed", code: "51", message: "The bank answered 51." });
  });

  it("5 transport failures in a row pause calls for 60 s; a turned-off connector isn't called", async () => {
    const down = await connector("https://localhost:1");
    for (let i = 0; i < 5; i++) await sendRun(db, A, await run(down));
    const sixth = await run(down);
    await sendRun(db, A, sixth);
    expect(await row(sixth)).toMatchObject({ status: "not_sent", message: "The bank is unreachable: calls paused for 60 s." });
    const off = await connector();
    await db.update(connectors).set({ disabledAt: new Date(), disabledReason: "Bank incident" }).where(eq(connectors.id, off));
    const r = await run(off);
    await sendRun(db, A, r);
    expect(await row(r)).toMatchObject({ status: "not_sent", message: "This connector is turned off: Bank incident" });
  });

  it("a run left sending by a dead worker becomes timeout and is never sent again", async () => {
    const r = await run(await connector());
    await db.update(actionRuns).set({ status: "sending", sendingAt: new Date(Date.now() - 10 * 60_000) }).where(eq(actionRuns.id, r));
    expect(await sweepStale(db)).toBe(1);
    expect(await row(r)).toMatchObject({ status: "timeout", message: "No answer recorded: the worker stopped while the call was out. Check with the bank before acting." });
    expect(await sendRun(db, A, r)).toBe("skip");
  });
});
