// Trusted devices (DEC-065, docs/standards/sign-in-trusted-device.md): a browser an account with two-factor
// authentication has trusted signs in with the one-time code only; the device token stands in for the password, so
// the sign-in keeps two factors. The token is 32 random bytes in the web's sealed `sk_device` cookie; only its SHA-256
// is stored, bound to one user and to that user's password hash and TOTP secret as they were when trusted.
import { and, desc, eq, gt, inArray, isNotNull, not, notInArray, or, type SQL, sql } from "drizzle-orm";
import type { Page } from "@starterkit/shared/contracts/common";
import type { TrustedAccountDto } from "@starterkit/shared/contracts/auth";
import type { TrustedDeviceDto, TrustedDeviceListQuery } from "@starterkit/shared/contracts/me";
import { hashToken, randomToken } from "../../kernel/crypto";
import { db, type Tx } from "../../kernel/db";
import { one, pageQuery, sortSql } from "../../kernel/pagination";
import type { Client } from "../../kernel/plugins/context";
import { recordAuth } from "../audit";
import { users } from "../users";
import { trustedDevices as d } from "./schema";
import { deviceOf } from "./sessions";

/** A trust ends this long after its last use … */
export const TRUST_IDLE_DAYS = 30;
/** … and never later than this after it was created. */
export const TRUST_CAP_DAYS = 90;
/** Trusted devices per user; a new one evicts the oldest. */
export const TRUST_MAX_PER_USER = 5;

/** What a trust is bound to: the user's credentials when it was made. A password change or a new TOTP secret ends it. */
export const boundHash = (u: { passwordHash: string | null; totpSecret: string | null }): Buffer =>
  hashToken(`${u.passwordHash ?? ""}\n${u.totpSecret ?? ""}`);

/** SQL: the trust has not ended (idle or capped). */
export const trustLive = (): SQL => and(gt(d.expiresAt, sql`now()`), gt(d.capAt, sql`now()`))!;

/** One sign-in log entry about device `label` of `user`, for this request's IP. */
const logDevice = (tx: Tx, client: Client, event: "device_trusted" | "device_revoked", user: { id: string; email: string }, label: string) =>
  recordAuth(tx, { event, method: "device", login: user.email, userId: user.id, ip: client.ip, device: label, location: null });

/**
 * Trust this browser for `user` (after a full sign-in, inside its transaction, the user's row locked): beyond
 * TRUST_MAX_PER_USER the oldest trusts go (each logged `device_revoked`). Returns the token for the cookie.
 */
export async function trustDevice(tx: Tx, user: { id: string; email: string; passwordHash: string | null; totpSecret: string | null }, client: Client): Promise<string> {
  const keep = await tx.select({ id: d.id }).from(d).where(eq(d.userId, user.id)).orderBy(desc(d.createdAt), desc(d.id)).limit(TRUST_MAX_PER_USER - 1);
  const evicted = await tx.delete(d).where(and(eq(d.userId, user.id), keep.length ? notInArray(d.id, keep.map((k) => k.id)) : undefined))
    .returning({ label: d.label });
  for (const e of evicted) await logDevice(tx, client, "device_revoked", user, e.label);
  const token = randomToken();
  const label = deviceOf(client.ua);
  await tx.insert(d).values({
    id: Bun.randomUUIDv7(), tokenHash: hashToken(token), userId: user.id, label, ip: client.ip, boundHash: boundHash(user),
    expiresAt: sql`now() + make_interval(days => ${TRUST_IDLE_DAYS})`, capAt: sql`now() + make_interval(days => ${TRUST_CAP_DAYS})`,
  });
  await logDevice(tx, client, "device_trusted", user, label);
  return token;
}

type LiveTrust = { id: string; slot: number; userId: string; name: string; username: string; email: string; createdAt: Date };

/**
 * The live trusts among `tokens` whose user is active, has two-factor authentication on and still has the credentials
 * the trust was bound to; `slot` is the token's index in `tokens`.
 */
async function liveTrusts(tokens: string[], where?: SQL): Promise<LiveTrust[]> {
  if (!tokens.length) return [];
  const hashes = tokens.map(hashToken);
  const rows = await db.select({
    id: d.id, tokenHash: d.tokenHash, boundHash: d.boundHash, createdAt: d.createdAt, userId: users.id, name: users.name, username: users.username,
    email: users.email, passwordHash: users.passwordHash, totpSecret: users.totpSecret,
  }).from(d).innerJoin(users, eq(users.id, d.userId))
    .where(and(inArray(d.tokenHash, hashes), trustLive(), users.isActive, isNotNull(users.totpSecret), where));
  return rows.filter((r) => r.boundHash.equals(boundHash(r))).map((r) => ({
    id: r.id, slot: hashes.findIndex((h) => h.equals(r.tokenHash)), userId: r.userId, name: r.name, username: r.username, email: r.email, createdAt: r.createdAt,
  }));
}

/** The accounts this browser may continue as: one per user (its newest trust), in the order the browser holds them. */
export async function trustedAccounts(tokens: string[]): Promise<TrustedAccountDto[]> {
  const newest = new Map<string, LiveTrust>();
  for (const t of await liveTrusts(tokens)) {
    const had = newest.get(t.userId);
    if (!had || t.createdAt > had.createdAt) newest.set(t.userId, t);
  }
  return [...newest.values()].sort((a, b) => a.slot - b.slot).map((t) => ({ slot: t.slot, name: t.name, login: t.username }));
}

/** The live trust of user `userId` among `tokens` (the newest when several), or null. */
export async function trustOf(tokens: string[], userId: string): Promise<LiveTrust | null> {
  const ts = await liveTrusts(tokens, eq(d.userId, userId));
  return ts.sort((a, b) => +b.createdAt - +a.createdAt)[0] ?? null;
}

/**
 * Sign-in through trust `id` (the code step, inside its transaction): still live, still `user`'s and bound to the same
 * credentials, else false. A use slides the expiry TRUST_IDLE_DAYS ahead, never past the cap.
 */
export async function useTrust(tx: Tx, id: string, user: { id: string; passwordHash: string | null; totpSecret: string | null }): Promise<boolean> {
  const [t] = await tx.select({ boundHash: d.boundHash }).from(d).where(and(eq(d.id, id), eq(d.userId, user.id), trustLive())).for("update");
  if (!t || !t.boundHash.equals(boundHash(user))) return false;
  await tx.update(d).set({ lastUsedAt: sql`now()`, expiresAt: sql`least(now() + make_interval(days => ${TRUST_IDLE_DAYS}), ${d.capAt})` }).where(eq(d.id, id));
  return true;
}

/**
 * "Forget on this device": the trust of `token` ends when it is `login`'s (username or email, any case); anything
 * else changes nothing. True when one ended.
 */
export async function forgetDevice(token: string, login: string, client: Client): Promise<boolean> {
  const key = login.trim().toLowerCase();
  return db.transaction(async (tx) => {
    const [t] = await tx.select({ id: d.id, label: d.label, userId: users.id, email: users.email }).from(d).innerJoin(users, eq(users.id, d.userId))
      .where(and(eq(d.tokenHash, hashToken(token)), or(eq(sql`lower(${users.username})`, key), eq(sql`lower(${users.email})`, key))));
    if (!t) return false;
    await tx.delete(d).where(eq(d.id, t.id));
    await logDevice(tx, client, "device_revoked", { id: t.userId, email: t.email }, t.label);
    return true;
  });
}

/**
 * Ends every trusted device of a user (password change or reset, two-factor turned on or off, deactivation), each one
 * logged `device_revoked` with this request's IP. Inside the change's transaction.
 */
export async function revokeTrustedDevices(tx: Tx, user: { id: string; email: string }, client: Client): Promise<void> {
  const gone = await tx.delete(d).where(eq(d.userId, user.id)).returning({ label: d.label });
  for (const g of gone) await logDevice(tx, client, "device_revoked", user, g.label);
}

/** Ends one live trusted device of `user` (account page, user page): its label, or undefined when it isn't theirs or has ended. */
export async function revokeTrustedDevice(tx: Tx, user: { id: string; email: string }, id: string, client: Client): Promise<string | undefined> {
  const [g] = await tx.delete(d).where(and(eq(d.id, id), eq(d.userId, user.id), trustLive())).returning({ label: d.label });
  if (g) await logDevice(tx, client, "device_revoked", user, g.label);
  return g?.label;
}

const DEVICE_SORTS = { lastUsedAt: d.lastUsedAt, label: sql`lower(${d.label})` };

/** One page of a user's live trusted devices (GET /v1/me/devices, /v1/users/{id}/devices), last used first by default. */
export function trustedDevicePage(userId: string, q: TrustedDeviceListQuery): Promise<Page<TrustedDeviceDto>> {
  const where = and(eq(d.userId, userId), trustLive());
  return pageQuery({
    rows: db.select({ id: d.id, label: d.label, ip: d.ip, createdAt: d.createdAt, lastUsedAt: d.lastUsedAt, expiresAt: d.expiresAt }).from(d).where(where).$dynamic(),
    count: db.select(one).from(d).where(where).$dynamic(),
    orderBy: sortSql(q.sort, DEVICE_SORTS, "-lastUsedAt", d.id),
    query: q,
    map: (r) => ({ id: r.id, label: r.label, ip: r.ip, createdAt: r.createdAt.toISOString(), lastUsedAt: r.lastUsedAt.toISOString(), expiresAt: r.expiresAt.toISOString() }),
  });
}

/** Janitor: trusts that have ended. */
export async function purgeTrustedDevices(tx: Tx): Promise<number> {
  return (await tx.delete(d).where(not(trustLive())).returning(one)).length;
}
