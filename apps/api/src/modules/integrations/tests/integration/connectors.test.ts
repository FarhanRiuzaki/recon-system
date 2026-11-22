// Open API connectors (DEC-053): integration.manage edits, another publishes (a Superadmin their own only by
// override); only the draft's maker saves it; integration.view reads; secrets are encrypted and never answered or
// logged; a connector's draft may be large (512 KB body).
import { beforeEach, describe, expect, it } from "bun:test";
import type { Page } from "@starterkit/shared/contracts/common";
import type { ConnectorDetailDto, ConnectorRowDto } from "@starterkit/shared/contracts/integrations";
import { eq, sql } from "drizzle-orm";
import { generateKeyPairSync } from "node:crypto";
import { call, platformAdmin, resetData, signIn } from "../../../../../test/helpers/app";
import { asAppRole } from "../../../../../test/helpers/app-role";
import { functionsOf } from "../../../../../test/helpers/db";
import { db } from "../../../../kernel/db";
import { activity } from "../../../audit";
import { roles, rolePermissions, userRoles } from "../../../rbac";
import { users } from "../../../users";
import { reconConfigs, reconConfigVersions } from "../../../recon";
import { spaces } from "../../../spaces";
import { connectorCircuits, connectors, connectorSecrets } from "../../schema";

const json = async <T>(r: Response | Promise<Response>) => (await (await r).json()) as T;
const err = async (r: Response) => ((await r.json()) as { error: { code: string; message: string } }).error;
const C = "/v1/integrations/connectors";
const env = { baseUrl: "https://api.bank.local:15000", host: "api.bank.local", partnerId: "P1", channelId: "C1" };
const op = (key: string, extra = 0) => ({
  key, name: `Operation ${key}`, method: "POST", path: "/openapi/v2.0/misc/debit-credit", timeoutMs: 30000,
  request: Array.from({ length: 1 + extra }, (_, i) => ({ name: `Field${i}`, type: "string", maxLength: 40, required: false })),
  response: [{ name: "ResponseCode", type: "string", required: false }], success: { field: "ResponseCode", equals: "00" }, reference: null, masked: [], presets: {},
});
const spec = (name = "Bank Mega", ops = [op("post")]) => ({ name, profile: "bank_mega_openapi_2_1", active: "dev", environments: { dev: env, prod: env }, operations: ops });
let t: Record<"m1" | "m2" | "sa" | "viewer" | "none", string>;

beforeEach(async () => {
  await resetData();
  await db.delete(connectors);
  // a role with integration.view only, for "google"
  const rid = Bun.randomUUIDv7();
  await db.insert(roles).values({ id: rid, name: "Open API reader" });
  await db.insert(rolePermissions).values({ roleId: rid, permission: "integration.view" });
  const [g] = await db.select({ id: users.id }).from(users).where(eq(users.username, "google"));
  await db.insert(userRoles).values({ userId: g!.id, roleId: rid });
  t = { m1: await signIn("admin"), m2: await platformAdmin(), sa: await signIn("superadmin"), viewer: await signIn("google"), none: await signIn("viewer") };
});

const create = (token: string, s = spec()) => json<ConnectorDetailDto>(call("POST", C, { token, body: { spec: s } }));
const publish = async (id: string, maker: string, by: string) => {
  await call("POST", `${C}/${id}/draft/submit`, { token: maker });
  return call("POST", `${C}/${id}/review/approve`, { token: by, body: {} });
};

describe("connectors", () => {
  it("a manager creates, another publishes; a reader reads and can't create; without the permission it's 403", async () => {
    const c = await create(t.m1);
    expect(c.open).toMatchObject({ version: 1, status: "draft" });
    expect((await err(await publish(c.id, t.m1, t.m1))).code).toBe("self_approval");
    expect((await json<ConnectorDetailDto>(call("POST", `${C}/${c.id}/review/approve`, { token: t.m2, body: {} }))).published).toMatchObject({ version: 1 });
    const list = await json<Page<ConnectorRowDto>>(call("GET", C, { token: t.viewer }));
    expect(list.items.map((r) => [r.name, r.published?.version, r.operations, r.active])).toEqual([["Bank Mega", 1, 1, "dev"]]);
    expect((await call("POST", C, { token: t.viewer, body: { spec: spec("X") } })).status).toBe(403);
    expect((await call("GET", C, { token: t.none })).status).toBe(403);
    expect((await err(await call("POST", C, { token: t.m1, body: { spec: spec("bank MEGA") } }))).code).toBe("duplicate");
  });

  it("a Superadmin publishes their own only by override; only the draft's maker saves it", async () => {
    const c = await create(t.sa);
    expect((await err(await publish(c.id, t.sa, t.sa))).code).toBe("self_approval");
    expect((await json<ConnectorDetailDto>(call("POST", `${C}/${c.id}/review/approve`, { token: t.sa, body: { override: true, comment: "Bank cutover" } }))).published).toMatchObject({ overrideReason: "Bank cutover" });
    await call("POST", `${C}/${c.id}/draft`, { token: t.m1 });
    expect((await err(await call("PATCH", `${C}/${c.id}/draft`, { token: t.m2, body: { spec: spec("Bank Mega", [op("post"), op("status")]) } }))).code).toBe("invalid_state");
  });

  it("secrets: replaced per environment, encrypted, never answered or logged", async () => {
    const c = await create(t.m1);
    const r = await call("PUT", `${C}/${c.id}/secrets`, { token: t.m1, body: { environment: "dev", clientSecret: "s3cret-value", clientId: "client-1" } });
    const text = await r.text();
    expect(text).not.toContain("s3cret-value");
    expect((JSON.parse(text) as ConnectorDetailDto).secrets.dev).toEqual({ clientId: true, clientSecret: true, publicKey: false, caBundle: false });
    expect((JSON.parse(text) as ConnectorDetailDto).secrets.prod.clientSecret).toBe(false);
    const [row] = await db.select().from(connectorSecrets).where(eq(connectorSecrets.connectorId, c.id));
    expect(row!.secretEnc).not.toContain("s3cret-value");
    const acts = await db.select({ action: activity.action, after: activity.after }).from(activity).where(eq(activity.targetId, c.id));
    expect(JSON.stringify(acts)).not.toContain("s3cret-value");
    expect(acts.find((a) => a.action === "integration.secrets")?.after).toEqual({ environment: "dev", replaced: ["clientId", "clientSecret"] });
    // a later replace keeps what it doesn't give
    const after = await json<ConnectorDetailDto>(call("PUT", `${C}/${c.id}/secrets`, { token: t.m1, body: { environment: "dev", clientId: "client-2" } }));
    expect(after.secrets.dev.clientSecret).toBe(true);
    expect((await err(await call("PUT", `${C}/${c.id}/secrets`, { token: t.m1, body: { environment: "dev" } }))).message).toBe("Enter at least one value to replace.");
    expect((await err(await call("PUT", `${C}/${c.id}/secrets`, { token: t.m1, body: { environment: "dev", publicKey: "hello" } }))).message).toBe("This isn't a public key. Paste the bank's public key (PEM).");
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
    const bare = publicKey.replace(/-----[A-Z ]+-----/g, "").replace(/\s+/g, "");
    expect((await json<ConnectorDetailDto>(call("PUT", `${C}/${c.id}/secrets`, { token: t.m1, body: { environment: "dev", publicKey: bare } }))).secrets.dev.publicKey).toBe(true);
    expect((await call("PUT", `${C}/${c.id}/secrets`, { token: t.viewer, body: { environment: "dev", clientId: "x" } })).status).toBe(403);
  });

  it("turned off with a reason, then on again", async () => {
    const c = await create(t.m1);
    expect((await err(await call("POST", `${C}/${c.id}/disable`, { token: t.m1, body: { reason: " " } }))).code).toBe("bad_request");
    const off = await json<ConnectorDetailDto>(call("POST", `${C}/${c.id}/disable`, { token: t.m1, body: { reason: "Bank incident" } }));
    expect(off.disabled).toMatchObject({ reason: "Bank incident" });
    expect((await json<ConnectorDetailDto>(call("POST", `${C}/${c.id}/enable`, { token: t.m1 }))).disabled).toBeNull();
  });

  it("a draft with many operations saves past 64 KB", async () => {
    const c = await create(t.m1);
    const big = spec("Bank Mega", Array.from({ length: 40 }, (_, i) => op(`op_${i}`, 60)));
    expect(JSON.stringify({ spec: big }).length).toBeGreaterThan(64 * 1024);
    const r = await call("PATCH", `${C}/${c.id}/draft`, { token: t.m1, body: { spec: big } });
    expect(r.status).toBe(200);
  });
});

describe("the connectors list and detail: bank link and used by (audit §5.8, C2)", () => {
  it("the active environment's last call result from its circuit, and how many recons' live versions call it, across spaces", async () => {
    const c = await create(t.m1);
    await publish(c.id, t.m1, t.m2);
    const row = async () => (await json<Page<ConnectorRowDto>>(call("GET", C, { token: t.viewer }))).items[0]!;
    expect(await row()).toMatchObject({ link: { state: "none", failures: 0 }, usedBy: 0 });
    await db.insert(connectorCircuits).values({ connectorId: c.id, environment: "dev", failures: 0 });
    expect((await row()).link).toEqual({ state: "answered", failures: 0 });
    await db.update(connectorCircuits).set({ failures: 2 });
    expect((await row()).link).toEqual({ state: "failing", failures: 2 });
    await db.update(connectorCircuits).set({ failures: 0, openUntil: new Date(Date.now() + 60_000) });
    expect((await row()).link.state).toBe("paused");
    // the prod circuit is not the active environment's
    await db.insert(connectorCircuits).values({ connectorId: c.id, environment: "prod", failures: 9 });
    expect((await row()).link.failures).toBe(0);
    // two spaces' live recons call it, a draft doesn't count
    await db.delete(spaces);
    const posting = { approvals: { changes: { write_off: { actions: [{ name: "Post", kind: "posting", on: { event: "approved" }, variants: [{ name: "D", operation: { connectorId: c.id, version: 1, key: "post" } }] }] } } } };
    for (const [i, status] of (["published", "published", "draft"] as const).entries()) {
      const sp = Bun.randomUUIDv7(), cfg = Bun.randomUUIDv7();
      await db.insert(spaces).values({ id: sp, code: `s${i}`, name: `S${i}` });
      await db.insert(reconConfigs).values({ id: cfg, spaceId: sp, code: `r${i}`, name: `R${i}` });
      await db.insert(reconConfigVersions).values({ id: Bun.randomUUIDv7(), configId: cfg, spaceId: sp, version: 1, status, spec: posting, specHash: "h", matchingHash: "h", makerId: Bun.randomUUIDv7() });
    }
    expect((await row()).usedBy).toBe(2);
    // the detail says it too: Turn off connector names how many recons use it (audit C2)
    expect((await json<ConnectorDetailDto>(call("GET", `${C}/${c.id}`, { token: t.viewer }))).usedBy).toBe(2);
  });

  it("used by comes from recon_connector_used_by: one call for the page, archived spaces left out, counts only", async () => {
    const [a, b] = [await create(t.m1, spec("A")), await create(t.m1, spec("B"))];
    await db.delete(spaces);
    const uses = (...ids: string[]) => ({ approvals: { changes: { write_off: { actions: [{ name: "Post", kind: "posting", on: { event: "approved" },
      variants: ids.map((id, i) => ({ name: `V${i}`, operation: { connectorId: id, version: 1, key: "post" } })) }] } } } });
    // a calls a twice in one recon (one recon), b once; the third space is archived
    for (const [i, [status, ids]] of ([["active", [a.id, a.id, b.id]], ["active", [a.id]], ["archived", [a.id, b.id]]] as const).entries()) {
      const sp = Bun.randomUUIDv7(), cfg = Bun.randomUUIDv7();
      await db.insert(spaces).values({ id: sp, code: `u${i}`, name: `U${i}`, status });
      await db.insert(reconConfigs).values({ id: cfg, spaceId: sp, code: `r${i}`, name: `R${i}` });
      await db.insert(reconConfigVersions).values({ id: Bun.randomUUIDv7(), configId: cfg, spaceId: sp, version: 1, status: "published", spec: uses(...ids), specHash: "h", matchingHash: "h", makerId: Bun.randomUUIDv7() });
    }
    // google reads connectors (integration.view) and holds no role in any space: it gets the numbers, nothing more
    const list = await json<Page<ConnectorRowDto>>(call("GET", C, { token: t.viewer }));
    expect(list.items.map((r) => [r.name, r.usedBy])).toEqual([["A", 2], ["B", 1]]);
    // the function as the app role, without a space scope: only (connector_id, recons), even though RLS hides every recon
    const got = await db.transaction(async (tx) => {
      await asAppRole(tx);
      return tx.select({ id: sql<string>`connector_id`, n: sql<number>`recons` }).from(sql`recon_connector_used_by(${`{${a.id},${b.id},${Bun.randomUUIDv7()}}`}::uuid[])`).orderBy(sql`recons desc`);
    });
    expect(got).toEqual([{ id: a.id, n: 2 }, { id: b.id, n: 1 }]);
    expect(await functionsOf(["recon_connector_used_by"])).toEqual([{ proname: "recon_connector_used_by", prosecdef: true, proconfig: [expect.stringMatching(/^search_path=/)] }]);
  });
});
