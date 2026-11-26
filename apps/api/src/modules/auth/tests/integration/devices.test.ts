// Trusted devices (DEC-065, docs/standards/sign-in-trusted-device.md): the tests every implementation carries, plus
// the account and user pages' list and revoke. Time moves by editing rows, since the database clock decides.
import { beforeEach, describe, expect, it } from "bun:test";
import { and, desc, eq, sql } from "drizzle-orm";
import { call, resetData, signIn } from "../../../../../test/helpers/app";
import { rows } from "../../../../../test/helpers/db";
import { SEED_PASSWORD, TOTP_SECRET } from "../../../../db/seed/demo";
import { hashToken } from "../../../../kernel/crypto";
import { db } from "../../../../kernel/db";
import { activity, authLog } from "../../../audit";
import { users } from "../../../users";
import { totpCode } from "../..";
import { authChallenges, loginBackoff, rateLimits, sessions, trustedDevices } from "../../schema";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36";
type Answer = { next: string; token: string; challenge: string; device?: string; password?: true; forgotten: boolean; accounts: { slot: number; name: string; login: string }[]; error: { code: string } };
type Res = Omit<Response, "json"> & { json(): Promise<Answer> };

const post = (path: string, body: unknown, challenge?: string) =>
  call("POST", `/v1/auth/${path}`, { body, headers: { "X-Client-Ua": UA, ...(challenge && { "X-Auth-Challenge": challenge }) } }) as Promise<Res>;
const idOf = async (username: string): Promise<string> => (await rows(db.select({ id: users.id }).from(users).where(eq(users.username, username))))[0].id;
/** Every TOTP step may be used again (each test signs in more than once within one 30 s step). */
const freshCode = async () => {
  await db.update(users).set({ totpLastStep: null }).where(eq(users.username, "twofa"));
  return totpCode(TOTP_SECRET);
};
const freshLimits = () => Promise.all([db.delete(rateLimits), db.delete(loginBackoff)]);

/** The full flow for `twofa`: password, then the code with `trust`. The answer of the code step. */
async function fullSignIn(trust: boolean): Promise<Answer> {
  const { challenge } = await (await post("login", { login: "twofa", password: SEED_PASSWORD })).json();
  const r = await post("2fa", { code: await freshCode(), trust }, challenge);
  expect(r.status).toBe(200);
  return r.json();
}
/** A trust for `twofa`: its device token. */
const trust = async () => (await fullSignIn(true)).device!;
/** The short flow: login and tokens, then the code. */
async function deviceSignIn(login: string, tokens: string[]): Promise<{ step1: Answer; step2?: Res }> {
  const step1 = await (await post("device", { login, tokens })).json();
  if (!step1.challenge) return { step1 };
  return { step1, step2: await post("2fa", { code: await freshCode() }, step1.challenge) };
}
const deviceRow = async (token: string) => (await rows(db.select().from(trustedDevices).where(eq(trustedDevices.tokenHash, hashToken(token)))))[0];
/** A column of user `username`, read through Drizzle. */
const userCol = async <K extends "passwordHash" | "totpSecret">(username: string, k: K) =>
  (await rows(db.select({ v: users[k] }).from(users).where(eq(users.username, username))))[0].v as string;
const events = async (event: string) => db.$count(authLog, eq(authLog.event, event));

beforeEach(resetData);

describe("trust this device", () => {
  it("a full sign-in with trust answers a device token and logs device_trusted; without trust none", async () => {
    expect((await fullSignIn(false)).device).toBeUndefined();
    expect(await db.$count(trustedDevices)).toBe(0);
    const t = await trust();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 random bytes
    const row = await deviceRow(t);
    expect(row).toMatchObject({ userId: await idOf("twofa"), label: "Chrome on macOS" });
    // only the hash is stored; 30 days idle, 90 days at most
    expect(Buffer.from(row.tokenHash).toString()).not.toContain(t);
    const [{ idle, cap }] = await rows(db.select({ idle: sql<number>`round(extract(epoch from ${trustedDevices.expiresAt} - now()) / 86400)`, cap: sql<number>`round(extract(epoch from ${trustedDevices.capAt} - now()) / 86400)` }).from(trustedDevices));
    expect([Number(idle), Number(cap)]).toEqual([30, 90]);
    expect(await events("device_trusted")).toBe(1);
  });

  it("at most 5 per user: a sixth evicts the oldest (logged device_revoked)", async () => {
    const tokens: string[] = [];
    for (let i = 0; i < 6; i++) {
      await freshLimits();
      tokens.push(await trust());
    }
    expect(await db.$count(trustedDevices)).toBe(5);
    expect(await deviceRow(tokens[0]!)).toBeUndefined();
    expect(await events("device_revoked")).toBe(1);
  });
});

describe("sign-in on a trusted browser: login → one-time code", () => {
  it("lists the account, then signs in with the code only (method device, the trust slides)", async () => {
    const t = await trust();
    expect((await (await post("devices", { tokens: ["nope", t] })).json()).accounts).toEqual([{ slot: 1, name: "Two Factor", login: "twofa" }]);
    await db.update(trustedDevices).set({ lastUsedAt: sql`now() - interval '10 days'`, expiresAt: sql`now() + interval '20 days'` });
    const { step1, step2 } = await deviceSignIn("TWOFA", [t]);
    expect(step1.next).toBe("/login/2fa");
    expect(step2!.status).toBe(200);
    const { token, device } = await step2!.json();
    expect(device).toBeUndefined(); // a device sign-in makes no new trust
    const [s] = await rows(db.select({ method: sessions.method }).from(sessions).where(eq(sessions.tokenHash, hashToken(token))));
    expect(s?.method).toBe("device");
    const [last] = await rows(db.select({ event: authLog.event, method: authLog.method }).from(authLog).orderBy(desc(authLog.at), desc(authLog.id)).limit(1));
    expect(last).toEqual({ event: "2fa_success", method: "device" });
    const [{ days }] = await rows(db.select({ days: sql<number>`round(extract(epoch from ${trustedDevices.expiresAt} - now()) / 86400)` }).from(trustedDevices));
    expect(Number(days)).toBe(30);
  });

  it("the slide never passes the 90-day cap", async () => {
    const t = await trust();
    await db.update(trustedDevices).set({ capAt: sql`now() + interval '2 days'` });
    expect((await deviceSignIn("twofa", [t])).step2!.status).toBe(200);
    const [{ days }] = await rows(db.select({ days: sql<number>`round(extract(epoch from ${trustedDevices.expiresAt} - now()) / 86400)` }).from(trustedDevices));
    expect(Number(days)).toBe(2);
  });

  it("no enumeration: an unknown login, another account, no tokens and a login without 2FA answer the same { password: true }", async () => {
    const t = await trust();
    const answers = await Promise.all([
      post("device", { login: "nobody-here", tokens: [t] }), post("device", { login: "admin", tokens: [t] }),
      post("device", { login: "twofa", tokens: [] }), post("device", { login: "viewer", tokens: [] }),
    ]);
    for (const r of answers) {
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ password: true } as never);
    }
    expect(await db.$count(authChallenges)).toBe(0);
  });

  it("a token is bound to one user: another account's NIP on the same browser gets the full flow", async () => {
    const t = await trust();
    // admin gets 2FA too, still no trust here
    await db.update(users).set({ totpSecret: await userCol("twofa", "totpSecret") }).where(eq(users.username, "admin"));
    expect((await deviceSignIn("admin", [t])).step1).toEqual({ password: true } as never);
  });

  it("expired, capped, revoked or deactivated: the full flow", async () => {
    const t = await trust();
    await db.update(trustedDevices).set({ expiresAt: sql`now() - interval '1 second'` });
    expect((await deviceSignIn("twofa", [t])).step1).toEqual({ password: true } as never);
    await db.update(trustedDevices).set({ expiresAt: sql`now() + interval '1 day'`, capAt: sql`now() - interval '1 second'` });
    expect((await deviceSignIn("twofa", [t])).step1).toEqual({ password: true } as never);
    await db.update(trustedDevices).set({ capAt: sql`now() + interval '1 day'` });
    await db.update(users).set({ isActive: false }).where(eq(users.username, "twofa"));
    expect((await deviceSignIn("twofa", [t])).step1).toEqual({ password: true } as never);
    expect((await (await post("devices", { tokens: [t] })).json()).accounts).toEqual([]);
    await db.update(users).set({ isActive: true }).where(eq(users.username, "twofa"));
    await db.delete(trustedDevices);
    expect((await deviceSignIn("twofa", [t])).step1).toEqual({ password: true } as never);
  });

  it("a trust that ends between the two steps: the code step is 401 and makes no session", async () => {
    const t = await trust();
    const { challenge } = await (await post("device", { login: "twofa", tokens: [t] })).json();
    // credentials changed (the bound hash no longer matches), challenge kept
    await db.update(users).set({ passwordHash: sql`${users.passwordHash} || 'x'` }).where(eq(users.username, "twofa"));
    const before = await db.$count(sessions);
    const r = await post("2fa", { code: await freshCode() }, challenge);
    expect(r.status).toBe(401);
    expect(await db.$count(sessions)).toBe(before);
    // revoked: its challenge goes with it
    await db.update(users).set({ passwordHash: sql`left(${users.passwordHash}, -1)` }).where(eq(users.username, "twofa"));
    const again = (await (await post("device", { login: "twofa", tokens: [t] })).json()).challenge;
    await db.delete(trustedDevices);
    expect((await post("2fa", { code: await freshCode() }, again)).status).toBe(401);
  });

  it("the one-time code lockout still applies on the short path", async () => {
    const t = await trust();
    await freshLimits();
    const { challenge } = await (await post("device", { login: "twofa", tokens: [t] })).json();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await post("2fa", { code: "000000" }, challenge)).status);
    expect(statuses.slice(0, 3)).toEqual([400, 400, 400]);
    expect(statuses).toContain(429);
    expect(await events("2fa_failed")).toBeGreaterThanOrEqual(3);
  });

  it("the login step counts toward the sign-in limits (5 per username a minute)", async () => {
    await freshLimits();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await post("device", { login: "twofa", tokens: [] })).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });
});

describe("forget on this device", () => {
  it("ends the trust only for its own login, logged device_revoked", async () => {
    const t = await trust();
    expect((await (await post("device/forget", { token: t, login: "admin" })).json()).forgotten).toBe(false);
    expect(await deviceRow(t)).toBeDefined();
    expect((await (await post("device/forget", { token: t, login: "twofa" })).json()).forgotten).toBe(true);
    expect(await deviceRow(t)).toBeUndefined();
    expect(await events("device_revoked")).toBe(1);
    expect((await deviceSignIn("twofa", [t])).step1).toEqual({ password: true } as never);
  });
});

describe("revoked with the credentials", () => {
  const trusted = async () => db.$count(trustedDevices, eq(trustedDevices.userId, await idOf("twofa")));

  it("a password change revokes every trust", async () => {
    await trust();
    const sid = await signIn("twofa");
    expect((await call("POST", "/v1/me/password", { token: sid, body: { current: SEED_PASSWORD, next: "Another-password-123!" } })).status).toBe(200);
    expect(await trusted()).toBe(0);
    expect(await events("device_revoked")).toBe(1);
  });

  it("turning 2FA off revokes every trust", async () => {
    await trust();
    expect((await call("DELETE", "/v1/me/2fa", { token: await signIn("twofa"), body: { password: SEED_PASSWORD } })).status).toBe(200);
    expect(await trusted()).toBe(0);
  });

  it("deactivation and an admin reset revoke every trust", async () => {
    const id = await idOf("twofa");
    const sa = await signIn("superadmin");
    await trust();
    expect((await call("POST", `/v1/users/${id}/reset-password`, { token: sa })).status).toBe(200);
    expect(await trusted()).toBe(0);
    await db.update(users).set({ passwordHash: await userCol("admin", "passwordHash"), mustChangePassword: false }).where(eq(users.id, id));
    await freshLimits();
    await trust();
    expect((await call("POST", `/v1/users/${id}/status`, { token: sa, body: { active: false } })).status).toBe(200);
    expect(await trusted()).toBe(0);
  });
});

describe("/v1/me/devices and /v1/users/{id}/devices", () => {
  it("the user lists and revokes their own; another user's is 404", async () => {
    await trust();
    const me = await signIn("twofa");
    const page = (await (await call("GET", "/v1/me/devices", { token: me })).json()) as { items: { id: string; label: string }[]; total: number };
    expect(page).toMatchObject({ total: 1, items: [{ label: "Chrome on macOS" }] });
    const id = page.items[0]!.id;
    expect((await call("DELETE", `/v1/me/devices/${id}`, { token: await signIn("admin") })).status).toBe(404);
    expect((await call("DELETE", "/v1/me/devices/not-a-uuid", { token: me })).status).toBe(404);
    expect((await call("DELETE", `/v1/me/devices/${id}`, { token: me })).status).toBe(200);
    expect(await db.$count(trustedDevices)).toBe(0);
    expect(await db.$count(activity, and(eq(activity.action, "me.device_revoke"), eq(activity.targetId, id)))).toBe(1);
    expect((await call("DELETE", `/v1/me/devices/${id}`, { token: me })).status).toBe(404);
  });

  it("an admin lists and revokes a user's; guard, 404 and actor rank", async () => {
    await trust();
    const uid = await idOf("twofa");
    const [{ id }] = await rows(db.select({ id: trustedDevices.id }).from(trustedDevices));
    expect((await call("GET", `/v1/users/${uid}/devices`)).status).toBe(401);
    expect((await call("DELETE", `/v1/users/${uid}/devices/${id}`, { token: await signIn("viewer") })).status).toBe(403);
    const admin = await signIn("admin");
    expect((await (await call("GET", `/v1/users/${uid}/devices`, { token: admin })).json()) as { total: number }).toMatchObject({ total: 1 });
    expect((await call("GET", `/v1/users/${Bun.randomUUIDv7()}/devices`, { token: admin })).status).toBe(404);
    expect((await call("DELETE", `/v1/users/${await idOf("admin")}/devices/${id}`, { token: admin })).status).toBe(404); // not that user's
    // actor rank: an Admin can't act on a Superadmin's devices
    const sa = await idOf("superadmin");
    const saDevice = Bun.randomUUIDv7();
    await db.insert(trustedDevices).values({ id: saDevice, tokenHash: hashToken("sa"), userId: sa, label: "x", ip: "1.1.1.1", boundHash: Buffer.from("b"), expiresAt: sql`now() + interval '1 day'`, capAt: sql`now() + interval '1 day'` });
    const r = await call("DELETE", `/v1/users/${sa}/devices/${saDevice}`, { token: admin });
    expect(r.status).toBe(403);
    expect(await db.$count(trustedDevices, eq(trustedDevices.id, saDevice))).toBe(1);
    expect((await call("DELETE", `/v1/users/${uid}/devices/${id}`, { token: admin })).status).toBe(200);
    expect(await db.$count(activity, eq(activity.action, "user.device_revoke"))).toBe(1);
  });
});
