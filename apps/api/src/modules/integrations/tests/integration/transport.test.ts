// Token, signed calls and Try it (DEC-053) against the fake bank: the profile end to end, the success rule, reference
// and masking, an answer that isn't encrypted, a timeout, one token for parallel calls, credentials refused without
// echoing them, an untrusted certificate, and Try it never reaching production.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import type { ConnectorDetailDto, TokenCheckDto, TryDto } from "@starterkit/shared/contracts/integrations";
import { call, platformAdmin, resetData, signIn } from "../../../../../test/helpers/app";
import { type FakeBank, fakeBank } from "../../../../../test/helpers/fake-bank";
import { db } from "../../../../kernel/db";
import { connectors } from "../../schema";

const C = "/v1/integrations/connectors";
const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
let bank: FakeBank, t: string;
const op = (key: string, path: string, extra: object = {}) => ({
  key, name: key, method: "POST", path, timeoutMs: 30000, request: [{ name: "Amount", type: "string", required: true }, { name: "Currency", type: "string", required: false }],
  response: [{ name: "ResponseCode", type: "string", required: false }, { name: "Ref", type: "string", required: false }, { name: "Account", type: "string", required: false }],
  success: { field: "ResponseCode", equals: "00" }, reference: "Ref", masked: ["Account"], presets: { Currency: "IDR" }, ...extra,
});
async function connector(o: { devUrl?: string; prodUrl?: string; secret?: string; ca?: boolean } = {}) {
  const env = (url: string) => ({ baseUrl: url, host: "localhost", partnerId: "P1", channelId: "C1" });
  const spec = { name: `Bank ${Bun.randomUUIDv7().slice(-6)}`, profile: "bank_mega_openapi_2_1", active: "dev",
    environments: { dev: env(o.devUrl ?? bank.url), prod: env(o.prodUrl ?? bank.url) },
    operations: [op("ok", "/ok"), op("html", "/html"), op("slow", "/slow", { timeoutMs: 1000 })] };
  const c = await json<ConnectorDetailDto>(call("POST", C, { token: t, body: { spec } }));
  for (const environment of ["dev", "prod"]) {
    await call("PUT", `${C}/${c.id}/secrets`, { token: t, body: { environment, clientId: bank.clientId, clientSecret: o.secret ?? bank.clientSecret, publicKey: bank.publicKey, ...(o.ca === false ? {} : { caBundle: bank.cert }) } });
  }
  return c.id;
}
const tryIt = (id: string, operation: string, body: unknown = { Amount: "150000" }) => json<TryDto>(call("POST", `${C}/${id}/try`, { token: t, body: { operation, body } }));

beforeAll(() => { bank = fakeBank(); });
afterAll(() => bank.stop());
beforeEach(async () => {
  await resetData();
  await db.delete(connectors);
  t = await signIn("admin");
});

describe("tokens follow reviewed settings (final review C1)", () => {
  it("Get token on production uses the published address, never a draft's; replacing credentials drops the cached token", async () => {
    const id = await connector();
    const m2 = await platformAdmin();
    await call("POST", `${C}/${id}/draft/submit`, { token: t });
    expect((await call("POST", `${C}/${id}/review/approve`, { token: m2, body: {} })).status).toBe(200);
    await call("POST", `${C}/${id}/draft`, { token: t });
    const d = await json<ConnectorDetailDto>(call("GET", `${C}/${id}`, { token: t }));
    const spec = d.open!.spec;
    expect((await call("PATCH", `${C}/${id}/draft`, { token: t, body: { spec: { ...spec, environments: { ...spec.environments, prod: { ...spec.environments.prod, baseUrl: "https://localhost:1" } } } } })).status).toBe(200);
    const before = bank.tokens;
    expect((await json<TokenCheckDto>(call("POST", `${C}/${id}/token-check`, { token: t, body: { environment: "prod" } }))).ok).toBe(true);
    expect(bank.tokens - before).toBe(1);
    // a cached dev token goes when the dev credentials are replaced
    await tryIt(id, "ok");
    const mid = bank.tokens;
    await call("PUT", `${C}/${id}/secrets`, { token: t, body: { environment: "dev", clientId: bank.clientId } });
    await tryIt(id, "ok");
    expect(bank.tokens - mid).toBe(1);
  });

  it("a cached token is for one address: a draft pointing dev to another bank asks that bank", async () => {
    const id = await connector();
    await tryIt(id, "ok");
    const other = fakeBank();
    try {
      const d = await json<ConnectorDetailDto>(call("GET", `${C}/${id}`, { token: t }));
      const spec = d.open!.spec;
      await call("PATCH", `${C}/${id}/draft`, { token: t, body: { spec: { ...spec, environments: { ...spec.environments, dev: { ...spec.environments.dev, baseUrl: other.url } } } } });
      await call("PUT", `${C}/${id}/secrets`, { token: t, body: { environment: "dev", publicKey: other.publicKey, caBundle: other.cert } });
      expect((await tryIt(id, "ok")).ok).toBe(true);
      expect(other.tokens).toBe(1);
    } finally { other.stop(); }
  });
});

describe("Try it against dev", () => {
  it("a signed, encrypted call: success rule, reference, masked fields, presets, a new external id each time", async () => {
    const id = await connector();
    const a = await tryIt(id, "ok");
    expect(a).toMatchObject({ ok: true, outcome: "ok", status: 200, success: true, reference: "R1" });
    expect((a.response as { Account: string }).Account).toBe("12******90");
    expect((a.response as { Echo: object }).Echo).toEqual({ Amount: "150000", Currency: "IDR" });
    expect(a.externalId).toMatch(/^\d{20}$/);
    const b = await tryIt(id, "ok");
    expect(BigInt(b.externalId!.slice(8))).toBe(BigInt(a.externalId!.slice(8)) + 1n);
    expect((await tryIt(id, "ok", { Amount: "1", fail: true })).success).toBe(false);
  });

  it("an answer that isn't encrypted is shown, never a 500", async () => {
    const r = await tryIt(await connector(), "html");
    expect(r).toMatchObject({ ok: false, outcome: "timeout", status: 502, message: "The bank answered 502 and the answer could not be read." });
    expect(r.raw).toContain("bad gateway");
  });

  it("no answer within the operation's time is a timeout", async () => {
    expect(await tryIt(await connector(), "slow")).toMatchObject({ ok: false, outcome: "timeout", message: "No answer from the bank within 1 s." });
  });

  it("two calls at once with no token cached ask the bank for one token", async () => {
    const id = await connector();
    const before = bank.tokens;
    const [a, b] = await Promise.all([tryIt(id, "ok"), tryIt(id, "ok")]);
    expect([a.ok, b.ok, bank.tokens - before]).toEqual([true, true, 1]);
  });

  it("refused credentials: a fixed sentence, the secret never echoed", async () => {
    const id = await connector({ secret: "wrong-secret-value" });
    const r = await call("POST", `${C}/${id}/token-check`, { token: t, body: { environment: "dev" } });
    const text = await r.text();
    expect(JSON.parse(text) as TokenCheckDto).toMatchObject({ ok: false, message: "The bank refused the credentials (HTTP 401)." });
    expect(text).not.toContain("wrong-secret-value");
    expect(text).not.toContain(Buffer.from(`${bank.clientId}:wrong-secret-value`).toString("base64"));
    expect((await tryIt(id, "ok")).outcome).toBe("not_sent");
  });

  it("a certificate the environment doesn't trust is not sent", async () => {
    expect(await tryIt(await connector({ ca: false }), "ok")).toMatchObject({ outcome: "not_sent", message: "The bank's certificate isn't trusted. Add the environment's CA bundle." });
  });

  it("Try it goes to dev only", async () => {
    const id = await connector({ devUrl: "https://localhost:1", prodUrl: bank.url });
    const calls = bank.calls.length;
    expect((await tryIt(id, "ok")).outcome).toBe("not_sent");
    expect(bank.calls.length).toBe(calls);
  });

  it("a good token check says how long the token lasts", async () => {
    const id = await connector();
    expect(await json<TokenCheckDto>(call("POST", `${C}/${id}/token-check`, { token: t, body: { environment: "dev" } }))).toMatchObject({ ok: true });
  });
});
