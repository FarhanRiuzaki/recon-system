// LDAP sign-in through the Bank Mega Open API gateway, as the Laravel recon-engine did it (LdapAuthController +
// ApiManagementService): the bank's LDAP is not reachable by bind, only through
//   1. a Keycloak token: POST {LDAP_GATEWAY_URL}/realms/{realm}/protocol/openid-connect/token, grant_type=password with
//      the service account (LDAP_GATEWAY_USERNAME/PASSWORD, also as Basic auth) and LDAP_GATEWAY_CLIENT_ID/SECRET;
//   2. GET /openapi/v1.0/ldap/verifypassword/userid/{login}/password/{Base64(AES-256-CBC(password))}, the password
//      encrypted with LDAP_GATEWAY_SECRET_KEY and a zero IV, signed like every Open API call: X-SIGNATURE =
//      Base64(HMAC-SHA512(client secret, GET:path:token:hex(sha256("{}")):timestamp)), with X-TIMESTAMP, X-PARTNER-ID,
//      X-EXTERNAL-ID and CHANNEL-ID; responseCode "00" = the password is right.
// Not the integrations connector (profile bank_mega_openapi_2_1): another realm and grant, no X-CREDENTIAL-KEY or body
// encryption, a plain JSON answer, and its path holds the (encrypted) password, so it is never written to a call log.
import { createCipheriv, createHash, createHmac, randomInt } from "node:crypto";
import type { Config } from "../../kernel/config";
import { log } from "../../kernel/log";

/** The gateway's settings (kernel/config.ts LDAP_GATEWAY_*), all set when LDAP_GATEWAY_URL is. */
export type GatewaySettings = {
  url: string;
  host?: string;
  realm: string;
  username: string;
  password: string;
  clientId: string;
  clientSecret: string;
  secretKey: string;
  partnerId: string;
  channelId: string;
  insecureTls: boolean;
};

export function gatewaySettings(c: Config): GatewaySettings | null {
  if (!c.LDAP_GATEWAY_URL) return null;
  return {
    url: c.LDAP_GATEWAY_URL.replace(/\/+$/, ""),
    host: c.LDAP_GATEWAY_HOST,
    realm: c.LDAP_GATEWAY_REALM,
    username: c.LDAP_GATEWAY_USERNAME!,
    password: c.LDAP_GATEWAY_PASSWORD!,
    clientId: c.LDAP_GATEWAY_CLIENT_ID!,
    clientSecret: c.LDAP_GATEWAY_CLIENT_SECRET!,
    secretKey: c.LDAP_GATEWAY_SECRET_KEY!,
    partnerId: c.LDAP_GATEWAY_PARTNER_ID!,
    channelId: c.LDAP_GATEWAY_CHANNEL_ID!,
    insecureTls: c.LDAP_GATEWAY_INSECURE_TLS,
  };
}

/**
 * The password as the gateway expects it: Base64(AES-256-CBC(password)), IV of 16 zero bytes, PKCS#7 padding. The key is
 * the secret's bytes cut or zero-padded to 32, as PHP's openssl_encrypt treats a key of another length.
 */
export function encryptPassword(password: string, secretKey: string): string {
  const key = Buffer.alloc(32);
  Buffer.from(secretKey, "utf8").copy(key, 0, 0, 32);
  const c = createCipheriv("aes-256-cbc", key, Buffer.alloc(16));
  return Buffer.concat([c.update(password, "utf8"), c.final()]).toString("base64");
}

/** X-TIMESTAMP: UTC to the second, with +00:00 (the Laravel app set the timezone to UTC before formatting). */
export const gatewayTimestamp = (now: Date): string => `${now.toISOString().slice(0, 19)}+00:00`;

/** X-SIGNATURE of a GET without a body: the body hash is of "{}", as the Laravel app signed it. */
export function gatewaySignature(i: { method: string; path: string; accessToken: string; timestamp: string; clientSecret: string }): string {
  const bodyHash = createHash("sha256").update("{}").digest("hex");
  return createHmac("sha512", i.clientSecret).update(`${i.method}:${i.path}:${i.accessToken}:${bodyHash}:${i.timestamp}`).digest("base64");
}

/** X-EXTERNAL-ID: 6 random digits, the Unix seconds, 4 random digits (20 digits, as the Laravel app made it). */
export const externalId = (now: Date): string => `${randomInt(100000, 1000000)}${Math.floor(now.getTime() / 1000)}${randomInt(1000, 10000)}`;

/** The verify path for `login` and the encrypted password; the login is URI-encoded (a NIP is unchanged), the password is not (as before). */
export const verifyPath = (login: string, encrypted: string): string =>
  `/openapi/v1.0/ldap/verifypassword/userid/${encodeURIComponent(login)}/password/${encrypted}`;

/** Why a sign-in failed, for the warn line: never the login, the password or a token. */
class GatewayError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "GatewayError";
  }
}

type Token = { value: string; until: number };
/** The service account's token per gateway settings, until 30 s before it ends (one per process). */
const tokens = new Map<string, Token>();
const tokenKey = (s: GatewaySettings) => `${s.url}\n${s.realm}\n${s.username}\n${s.clientId}`;

const tlsOf = (s: GatewaySettings) => (s.insecureTls ? { tls: { rejectUnauthorized: false } } : {});
const withHost = (s: GatewaySettings, h: Record<string, string>) => (s.host ? { ...h, Host: s.host } : h);

async function token(s: GatewaySettings, signal: AbortSignal, fresh: boolean): Promise<string> {
  const key = tokenKey(s);
  const cached = tokens.get(key);
  if (!fresh && cached && cached.until > Date.now()) return cached.value;
  const body = new URLSearchParams({ grant_type: "password", username: s.username, password: s.password, client_id: s.clientId, client_secret: s.clientSecret });
  const res = await fetch(`${s.url}/realms/${encodeURIComponent(s.realm)}/protocol/openid-connect/token`, {
    method: "POST", body: body.toString(), signal, ...tlsOf(s),
    headers: withHost(s, {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${Buffer.from(`${s.username}:${s.password}`).toString("base64")}`,
    }),
  });
  const json = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
  if (res.status !== 200 || typeof json?.access_token !== "string") throw new GatewayError(`token_http_${res.status}`);
  const ttl = typeof json.expires_in === "number" ? json.expires_in : 60;
  const value = json.access_token.trim();
  tokens.set(key, { value, until: Date.now() + Math.max(0, ttl - 30) * 1000 });
  return value;
}

/** One verify call; the answer's responseCode, or a GatewayError for an HTTP 401 (`unauthorized`) or no JSON. */
async function verifyOnce(s: GatewaySettings, signal: AbortSignal, accessToken: string, login: string, password: string): Promise<string> {
  const path = verifyPath(login, encryptPassword(password, s.secretKey));
  const now = new Date();
  const ts = gatewayTimestamp(now);
  const res = await fetch(`${s.url}${path}`, {
    method: "GET", signal, ...tlsOf(s),
    headers: withHost(s, {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "X-SIGNATURE": gatewaySignature({ method: "GET", path, accessToken, timestamp: ts, clientSecret: s.clientSecret }),
      "X-TIMESTAMP": ts,
      "X-PARTNER-ID": s.partnerId,
      "X-EXTERNAL-ID": externalId(now),
      "CHANNEL-ID": s.channelId,
    }),
  });
  if (res.status === 401) throw new GatewayError("unauthorized");
  const json = (await res.json().catch(() => null)) as { responseCode?: unknown } | null;
  if (!json || json.responseCode === undefined) throw new GatewayError(`verify_http_${res.status}`);
  return String(json.responseCode);
}

/** responseCode → the reason logged when it isn't "00" (the codes the Laravel app knew). */
const REASONS: Record<string, string> = {
  "99": "user not found",
  "96": "wrong password or encryption key",
  "94": "password change required",
  "90": "insufficient permissions",
};

/**
 * True when the gateway says `password` is the directory password of `login` (responseCode "00"), within `timeoutMs`
 * in all (token and verify). A token the gateway refuses (HTTP 401) is fetched again once. Any other answer or error is
 * false and one warn line with the response code or error name, never the login, the password or a token.
 */
export async function verifyGateway(s: GatewaySettings, timeoutMs: number, login: string, password: string): Promise<boolean> {
  if (!password || !login) return false;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    let code: string;
    try {
      code = await verifyOnce(s, signal, await token(s, signal, false), login, password);
    } catch (e) {
      if (!(e instanceof GatewayError && e.code === "unauthorized")) throw e;
      code = await verifyOnce(s, signal, await token(s, signal, true), login, password);
    }
    if (code === "00") return true;
    log.warn({ responseCode: code, reason: REASONS[code] ?? "unknown" }, "ldap gateway sign-in refused");
    return false;
  } catch (e) {
    const name = e instanceof GatewayError ? e.code : e instanceof Error ? e.name : typeof e;
    log.warn({ err: { name } }, "ldap gateway sign-in failed");
    return false;
  }
}

/** Forgets the cached tokens (tests). */
export const resetGatewayTokens = (): void => tokens.clear();
