import "server-only";
import { getIronSession, type SessionOptions } from "iron-session";
import { cookies, headers } from "next/headers";
import type { TrustedAccountDto, TrustedAccountsDto } from "@starterkit/shared/contracts/auth";
import { backendJson } from "./backend";
import { type Config, config } from "./config";

export const DEVICE_COOKIE = "sk_device";

/** Accounts one browser may trust (DEC-065): the API keeps at most 5 trusts per user, this cookie at most 5 per browser. */
export const MAX_DEVICE_TOKENS = 5;

/** The API's 90-day cap on a trust: the cookie never outlives it. */
const DEVICE_TTL_S = 90 * 24 * 3600;

/**
 * The trusted-device cookie (DEC-065): sealed like the session (iron-session, SESSION_SECRET), `httpOnly`,
 * `sameSite: "strict"`, `secure` with COOKIE_SECURE, `path: "/"`. It holds only `{ tokens }`, the device tokens the
 * API answered, newest last; the accounts behind them come from the API. Sign-out leaves it.
 */
export type DeviceCookie = { tokens?: string[] };

export function deviceOptions(c: Config = config()): SessionOptions {
  return {
    password: c.SESSION_SECRET,
    cookieName: DEVICE_COOKIE,
    ttl: DEVICE_TTL_S,
    cookieOptions: { httpOnly: true, sameSite: "strict", secure: c.COOKIE_SECURE, path: "/" },
  };
}

export async function getDeviceCookie() {
  return getIronSession<DeviceCookie>(await cookies(), deviceOptions());
}

/** This browser's device tokens (none when the cookie is missing or doesn't unseal). */
export async function deviceTokens(): Promise<string[]> {
  return ((await getDeviceCookie()).tokens ?? []).slice(-MAX_DEVICE_TOKENS);
}

/** The accounts this browser may continue as (`POST /v1/auth/devices`); none when it holds no token. */
export async function trustedAccounts(tokens?: string[], req?: { headers: Headers }): Promise<TrustedAccountDto[]> {
  const t = tokens ?? (await deviceTokens());
  if (!t.length) return [];
  const { data } = await backendJson<TrustedAccountsDto>("/v1/auth/devices", {
    method: "POST", body: JSON.stringify({ tokens: t }), contentType: "application/json", req: req ?? { headers: await headers() },
  });
  return data?.accounts ?? [];
}

/**
 * Keeps a new device token: the tokens the API still answers an account for (one per account), then `token`; the
 * oldest go past MAX_DEVICE_TOKENS.
 */
export async function addDeviceToken(token: string, req: Request): Promise<void> {
  const c = await getDeviceCookie();
  const held = (c.tokens ?? []).slice(-MAX_DEVICE_TOKENS);
  const live = (await trustedAccounts(held, req)).map((a) => held[a.slot]!);
  c.tokens = [...live, token].slice(-MAX_DEVICE_TOKENS);
  await c.save();
}

/** Drops the token at `slot`. */
export async function dropDeviceToken(slot: number): Promise<void> {
  const c = await getDeviceCookie();
  const held = (c.tokens ?? []).slice(-MAX_DEVICE_TOKENS);
  c.tokens = held.filter((_, i) => i !== slot);
  if (c.tokens.length) await c.save();
  else c.destroy();
}
