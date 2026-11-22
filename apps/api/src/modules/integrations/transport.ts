// Calls to a bank Open API (DEC-053; spec §4.2, §4.6): the access token cached per connector and environment (one
// request at a time under a lock, renewed 30 s before it ends), the X-EXTERNAL-ID counter per connector and day, and one
// signed, encrypted call with the operation's time limit. Outcomes: ok (2xx, read), rejected (the bank refused it),
// not_sent (it never left: credentials, certificate, network, token), timeout (sent, no readable answer in time: its
// effect at the bank is unknown). Never logs or answers a secret, a token or a payload.
import type { EnvironmentSettings, OperationSpec } from "@starterkit/shared/contracts/integrations";
import type { Environment } from "@starterkit/shared/integrations";
import { and, eq, sql } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../../kernel/crypto";
import { db } from "../../kernel/db";
import { connectorTokenLock } from "../../kernel/locks";
import { todayIn } from "../ingest";
import { openResponse, sealRequest, TOKEN_PATH } from "./profile";
import { connectorExternalIds, connectorTokens } from "./schema";
import type { Secrets } from "./service";

export type Outcome = "ok" | "rejected" | "not_sent" | "timeout";
export type SendResult = { outcome: Outcome; status: number | null; externalId: string | null; ms: number; json: unknown | null; raw: string | null; message: string };
/** A call that never left: credentials, certificate, network or token, in words. */
export class NotSent extends Error {}

const TOKEN_TIMEOUT_MS = 8000; // inside the token lock's transaction (idle in transaction ends it at 10 s)
const TLS_CODES = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|TLS|SSL/i;
/** A fetch that failed before an answer, in words; `sent` = the request may have reached the bank. */
function failure(e: unknown, ms: number): { sent: boolean; message: string } {
  const x = e as { name?: string; code?: string };
  if (x.name === "TimeoutError" || x.name === "AbortError") return { sent: true, message: `No answer from the bank within ${Math.round(ms / 1000)} s.` };
  if (TLS_CODES.test(String(x.code ?? ""))) return { sent: false, message: "The bank's certificate isn't trusted. Add the environment's CA bundle." };
  return { sent: false, message: `The bank couldn't be reached${x.code ? ` (${x.code})` : ""}.` };
}
const tlsOf = (s: Secrets) => (s.caBundle ? { tls: { ca: [s.caBundle] } } : {});

/** The bank's access token for the environment; a new one when none is cached or it ends within 30 s (`fresh` forces one). */
export async function accessToken(connectorId: string, env: Environment, settings: EnvironmentSettings, secrets: Secrets, fresh = false): Promise<{ token: string; expiresIn: number }> {
  if (!settings.baseUrl) throw new NotSent("Enter this environment's address first.");
  if (!secrets.clientId || !secrets.clientSecret) throw new NotSent("Set the client ID and client secret of this environment first.");
  return db.transaction(async (tx) => {
    await connectorTokenLock(tx, `${connectorId}:${env}`);
    const [c] = await tx.select().from(connectorTokens).where(and(eq(connectorTokens.connectorId, connectorId), eq(connectorTokens.environment, env)));
    if (!fresh && c && c.expiresAt.getTime() - Date.now() > 30_000) return { token: decryptSecret(c.tokenEnc), expiresIn: Math.round((c.expiresAt.getTime() - Date.now()) / 1000) };
    let res: Response;
    try {
      res = await fetch(`${settings.baseUrl.replace(/\/$/, "")}${TOKEN_PATH}`, {
        method: "POST", body: "grant_type=client_credentials", signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS), ...tlsOf(secrets),
        headers: { Host: settings.host, "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${secrets.clientId}:${secrets.clientSecret}`).toString("base64")}` },
      });
    } catch (e) {
      throw new NotSent(failure(e, TOKEN_TIMEOUT_MS).message.replace("No answer from the bank", "No token from the bank"));
    }
    if (!res.ok) throw new NotSent(`The bank refused the credentials (HTTP ${res.status}).`);
    const body = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
    if (!body?.access_token) throw new NotSent("The bank's token answer has no access token.");
    const life = Math.max(1, Number(body.expires_in) || 300);
    const enc = encryptSecret(body.access_token), expiresAt = new Date(Date.now() + life * 1000);
    await tx.insert(connectorTokens).values({ connectorId, environment: env, tokenEnc: enc, expiresAt })
      .onConflictDoUpdate({ target: [connectorTokens.connectorId, connectorTokens.environment], set: { tokenEnc: enc, expiresAt } });
    return { token: body.access_token, expiresIn: life };
  });
}

/** The next X-EXTERNAL-ID: yyyyMMdd (Asia/Jakarta) + a 12-digit number per connector and day, never given twice. */
export async function nextExternalId(connectorId: string, now = new Date()): Promise<string> {
  const day = todayIn(now);
  const [r] = await db.insert(connectorExternalIds).values({ connectorId, day, n: 1 })
    .onConflictDoUpdate({ target: [connectorExternalIds.connectorId, connectorExternalIds.day], set: { n: sql`${connectorExternalIds.n} + 1` } }).returning({ n: connectorExternalIds.n });
  return `${day.replace(/-/g, "")}${String(r!.n).padStart(12, "0")}`;
}

/** The request body with the operation's fixed values where the body leaves them out. */
export function withPresets(body: unknown, presets: Readonly<Record<string, string>>): unknown {
  const out = structuredClone(body ?? {}) as Record<string, unknown>;
  for (const [path, v] of Object.entries(presets)) {
    const parts = path.split(".");
    let at: Record<string, unknown> = out;
    for (const p of parts.slice(0, -1)) at = (at[p] ??= {}) as Record<string, unknown>;
    at[parts.at(-1)!] ??= v;
  }
  return out;
}

/** One call of `op` to the environment: signed, encrypted, within the operation's time. Never throws for the bank. */
export async function sendOperation(i: { connectorId: string; env: Environment; op: OperationSpec; settings: EnvironmentSettings; secrets: Secrets | null; body: unknown }): Promise<SendResult> {
  const start = Date.now();
  const done = (r: Omit<SendResult, "ms">): SendResult => ({ ...r, ms: Date.now() - start });
  const s = i.secrets ?? {};
  if (!i.settings.baseUrl) return done({ outcome: "not_sent", status: null, externalId: null, json: null, raw: null, message: "Enter this environment's address first." });
  if (!s.clientId || !s.clientSecret || !s.publicKey) {
    return done({ outcome: "not_sent", status: null, externalId: null, json: null, raw: null, message: "Set this environment's client ID, client secret and the bank's public key first." });
  }
  let token: string;
  try {
    token = (await accessToken(i.connectorId, i.env, i.settings, s)).token;
  } catch (e) {
    if (e instanceof NotSent) return done({ outcome: "not_sent", status: null, externalId: null, json: null, raw: null, message: e.message });
    throw e;
  }
  const json = i.op.method === "GET" ? "" : JSON.stringify(withPresets(i.body, i.op.presets));
  const externalId = await nextExternalId(i.connectorId);
  const sealed = sealRequest({ method: i.op.method, path: i.op.path, json, accessToken: token, clientSecret: s.clientSecret, publicKey: s.publicKey, now: new Date() });
  let res: Response;
  try {
    res = await fetch(`${i.settings.baseUrl.replace(/\/$/, "")}${i.op.path}`, {
      method: i.op.method, ...(i.op.method === "GET" ? {} : { body: sealed.body }), signal: AbortSignal.timeout(i.op.timeoutMs), ...tlsOf(s),
      headers: {
        Authorization: `Bearer ${token}`, "Content-Type": "application/json", Host: i.settings.host, "X-PARTNER-ID": i.settings.partnerId, "CHANNEL-ID": i.settings.channelId,
        "X-EXTERNAL-ID": externalId, ...sealed.headers,
      },
    });
  } catch (e) {
    const f = failure(e, i.op.timeoutMs);
    return done({ outcome: f.sent ? "timeout" : "not_sent", status: null, externalId, json: null, raw: null, message: f.message });
  }
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    return done({ outcome: "timeout", status: res.status, externalId, json: null, raw: null, message: failure(e, i.op.timeoutMs).message });
  }
  const opened = openResponse(text, sealed.key, sealed.iv);
  if ("json" in opened) {
    return done({ outcome: res.ok ? "ok" : "rejected", status: res.status, externalId, json: opened.json, raw: null, message: res.ok ? "The bank answered." : `The bank refused it (HTTP ${res.status}).` });
  }
  const raw = text.slice(0, 2000);
  // a refusal before the operation ran (token, signature) comes back plain: refused, nothing booked
  if (res.status === 401 || res.status === 403) return done({ outcome: "rejected", status: res.status, externalId, json: null, raw, message: `The bank refused it (HTTP ${res.status}).` });
  return done({ outcome: "timeout", status: res.status, externalId, json: null, raw, message: `The bank answered ${res.status} and the answer could not be read.` });
}
