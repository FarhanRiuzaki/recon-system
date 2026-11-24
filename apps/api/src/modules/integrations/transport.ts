// Calls to a bank Open API (DEC-053; spec §4.2, §4.6): the access token cached per connector and environment (one
// request at a time under a lock, renewed 30 s before it ends), the X-EXTERNAL-ID counter per connector and day, and one
// signed, encrypted call with the operation's time limit. Outcomes: ok (2xx, read), rejected (the bank refused it),
// not_sent (it never left: credentials, certificate, network, token), timeout (sent, no readable answer in time: its
// effect at the bank is unknown). Never logs or answers a secret, a token or a payload. TLS is checked only where the
// environment asks (verifyTls): the bank's internal endpoints carry certificates no client checks (owner, 22 Nov).
// Every call, made or tried, is one row of the call log (call-log.ts), written after it with the caller's `call`.
import type { EnvironmentSettings, OperationSpec } from "@starterkit/shared/contracts/integrations";
import { type Environment, maskTree, readPath, withAuto, withPresets } from "@starterkit/shared/integrations";
import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { decryptSecret, encryptSecret } from "../../kernel/crypto";
import { db } from "../../kernel/db";
import { connectorTokenLock } from "../../kernel/locks";
import { todayIn } from "../ingest";
import { CallDraft, type CallMeta, type FullCall, tokenTail } from "./call-log";
import { openResponse, sealRequest, TOKEN_PATH } from "./profile";
import { connectorExternalIds, connectorTokens } from "./schema";
import type { Secrets } from "./service";

export type Outcome = "ok" | "rejected" | "not_sent" | "timeout";
export type SendResult = {
  outcome: Outcome; status: number | null; externalId: string | null; ms: number; json: unknown | null; raw: string | null; message: string;
  /** The auto values the system filled (dot path → value): ids and times, never a secret. */
  filled: Record<string, string>;
};
/** A call that never left: credentials, certificate, network or token, in words. */
export class NotSent extends Error {}

const TOKEN_TIMEOUT_MS = 8000; // inside the token lock's transaction (idle in transaction ends it at 10 s)
const TLS_CODES = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|TLS|SSL/i;
/** A fetch that failed before an answer, in words; `sent` = the request may have reached the bank. */
function failure(e: unknown, ms: number): { sent: boolean; message: string } {
  const x = e as { name?: string; code?: string };
  if (x.name === "TimeoutError" || x.name === "AbortError") return { sent: true, message: `No answer from the bank within ${Math.round(ms / 1000)} s.` };
  if (TLS_CODES.test(String(x.code ?? ""))) return { sent: false, message: "This server doesn't trust the bank's certificate. Ask IT to add the bank's root certificate to the server (NODE_EXTRA_CA_CERTS), or paste it as this environment's CA bundle." };
  return { sent: false, message: `The bank couldn't be reached${x.code ? ` (${x.code})` : ""}.` };
}
/** TLS options: the environment's CA bundle when it checks the certificate; no check when it doesn't (verifyTls off). */
const tlsOf = (settings: EnvironmentSettings, s: Secrets) =>
  !settings.verifyTls ? { tls: { rejectUnauthorized: false } } : s.caBundle ? { tls: { ca: [s.caBundle] } } : {};

type Finish = Parameters<CallDraft["finish"]>[0];
const TOKEN_BODY = "grant_type=client_credentials";
const headersOf = (h: Headers): Record<string, string> => Object.fromEntries(h.entries());
/** An object parsed from `text`; null when it isn't JSON or isn't an object. */
const jsonOf = (text: string): object | null => {
  try { const v: unknown = JSON.parse(text); return v && typeof v === "object" ? v : null; } catch { return null; }
};

/**
 * The bank's access token for the environment; a new one when none is cached or it ends within 30 s (`fresh` forces one).
 * A request to the bank is logged (`call`) after the token lock's transaction; a cached token is no call.
 */
export async function accessToken(connectorId: string, env: Environment, settings: EnvironmentSettings, secrets: Secrets, call: CallMeta, fresh = false): Promise<{ token: string; expiresIn: number }> {
  const basic = secrets.clientId && secrets.clientSecret ? Buffer.from(`${secrets.clientId}:${secrets.clientSecret}`).toString("base64") : "";
  const logged = new CallDraft({ connectorId, env, meta: call, operationKey: null, method: "POST", baseUrl: settings.baseUrl, path: TOKEN_PATH }).hide(secrets.clientSecret).hide(basic);
  const refuse = (m: string): never => { logged.finish({ outcome: "not_sent", message: m }); throw new NotSent(m); };
  if (!settings.baseUrl) refuse("Enter this environment's address first.");
  if (!secrets.clientId || !secrets.clientSecret) refuse("Set the client ID and client secret of this environment first.");
  const out: { done?: Finish } = {};
  try {
    return await db.transaction(async (tx) => {
      await connectorTokenLock(tx, `${connectorId}:${env}`);
      const fingerprint = createHash("sha256").update(`${settings.baseUrl}\n${settings.host}\n${secrets.clientId}`).digest("hex");
      const [c] = await tx.select().from(connectorTokens).where(and(eq(connectorTokens.connectorId, connectorId), eq(connectorTokens.environment, env)));
      if (!fresh && c && c.fingerprint === fingerprint && c.expiresAt.getTime() - Date.now() > 30_000) return { token: decryptSecret(c.tokenEnc), expiresIn: Math.round((c.expiresAt.getTime() - Date.now()) / 1000) };
      const url = `${settings.baseUrl.replace(/\/$/, "")}${TOKEN_PATH}`;
      const headers = { Host: settings.host, "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${basic}` };
      const full: FullCall = { request: { method: "POST", url, headers: { ...headers, Authorization: "Basic (hidden)" }, json: null, body: TOKEN_BODY }, response: null };
      const requestMasked = { grant_type: "client_credentials" };
      let res: Response;
      try {
        res = await fetch(url, { method: "POST", body: TOKEN_BODY, signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS), ...tlsOf(settings, secrets), headers });
      } catch (e) {
        const f = failure(e, TOKEN_TIMEOUT_MS);
        const message = f.message.replace("No answer from the bank", "No token from the bank");
        out.done = { outcome: f.sent ? "timeout" : "not_sent", message, requestMasked, full };
        throw new NotSent(message);
      }
      const text = await res.text().catch(() => "");
      const body = jsonOf(text) as { access_token?: unknown; expires_in?: number } | null;
      const token = typeof body?.access_token === "string" && body.access_token ? body.access_token : null;
      if (token) logged.hide(token, true);
      const shown = body && typeof body === "object" ? { ...body, ...(token ? { access_token: tokenTail(token) } : {}) } : null;
      full.response = { status: res.status, headers: headersOf(res.headers), raw: text, json: shown };
      const answered = (outcome: "ok" | "rejected", message: string): Finish => ({ outcome, httpStatus: res.status, message, requestMasked, responseMasked: shown, full });
      if (!res.ok) { out.done = answered("rejected", `The bank refused the credentials (HTTP ${res.status}).`); throw new NotSent(out.done.message); }
      if (!token) { out.done = answered("rejected", "The bank's token answer has no access token."); throw new NotSent(out.done.message); }
      const life = Math.min(3600, Math.max(1, Number(body?.expires_in) || 300)); // a token that claims longer is asked again within the hour
      const enc = encryptSecret(token), expiresAt = new Date(Date.now() + life * 1000);
      await tx.insert(connectorTokens).values({ connectorId, environment: env, tokenEnc: enc, fingerprint, expiresAt })
        .onConflictDoUpdate({ target: [connectorTokens.connectorId, connectorTokens.environment], set: { tokenEnc: enc, fingerprint, expiresAt } });
      out.done = answered("ok", `The bank gave a token that lasts ${life} s.`);
      return { token, expiresIn: life };
    });
  } finally {
    // after the lock's transaction: the log never holds it, and never fails the token
    if (out.done) logged.finish(out.done);
  }
}

/** The next X-EXTERNAL-ID: yyyyMMdd (Asia/Jakarta) + a 12-digit number per connector and day, never given twice. */
export async function nextExternalId(connectorId: string, now = new Date()): Promise<string> {
  const day = todayIn(now);
  const [r] = await db.insert(connectorExternalIds).values({ connectorId, day, n: 1 })
    .onConflictDoUpdate({ target: [connectorExternalIds.connectorId, connectorExternalIds.day], set: { n: sql`${connectorExternalIds.n} + 1` } }).returning({ n: connectorExternalIds.n });
  return `${day.replace(/-/g, "")}${String(r!.n).padStart(12, "0")}`;
}

/**
 * One call of `op` to the environment: signed, encrypted, within the operation's time. Never throws for the bank. Logged
 * once it ended (`call`), a call that never left too; its token request is logged on its own with the same origin.
 */
export async function sendOperation(i: { connectorId: string; env: Environment; op: OperationSpec; settings: EnvironmentSettings; secrets: Secrets | null; body: unknown; call: CallMeta }): Promise<SendResult> {
  const start = Date.now();
  let filled: Record<string, string> = {};
  const s = i.secrets ?? {};
  const logged = new CallDraft({ connectorId: i.connectorId, env: i.env, meta: i.call, operationKey: i.op.key, method: i.op.method, baseUrl: i.settings.baseUrl, path: i.op.path }).hide(s.clientSecret);
  let requestMasked: unknown = maskTree(withPresets(i.body, i.op.presets), i.op.masked);
  let full: FullCall | null = null;
  const done = (r: Omit<SendResult, "ms" | "filled">): SendResult => {
    const code = r.json !== null && i.op.success ? String(readPath(r.json, i.op.success.field) ?? "") || null : null;
    logged.finish({ outcome: r.outcome, httpStatus: r.status, code, message: r.message, externalId: r.externalId, requestMasked,
      responseMasked: r.json !== null ? maskTree(r.json, i.op.masked) : r.raw !== null ? { raw: r.raw } : null, full });
    return { ...r, ms: Date.now() - start, filled };
  };
  if (!i.settings.baseUrl) return done({ outcome: "not_sent", status: null, externalId: null, json: null, raw: null, message: "Enter this environment's address first." });
  if (!s.clientId || !s.clientSecret || !s.publicKey) {
    return done({ outcome: "not_sent", status: null, externalId: null, json: null, raw: null, message: "Set this environment's client ID, client secret and the bank's public key first." });
  }
  let token: string;
  try {
    token = (await accessToken(i.connectorId, i.env, i.settings, s, i.call)).token;
  } catch (e) {
    if (e instanceof NotSent) return done({ outcome: "not_sent", status: null, externalId: null, json: null, raw: null, message: e.message });
    throw e;
  }
  logged.hide(token, true);
  let externalId: string, sealed: ReturnType<typeof sealRequest>, json: string;
  try {
    externalId = await nextExternalId(i.connectorId);
    // fixed values where the body leaves them out, then the auto values over whatever it has
    const auto = withAuto(withPresets(i.body, i.op.presets), i.op.auto ?? {}, { externalId, now: new Date() });
    filled = auto.filled;
    requestMasked = maskTree(auto.body, i.op.masked);
    json = i.op.method === "GET" ? "" : JSON.stringify(auto.body);
    sealed = sealRequest({ method: i.op.method, path: i.op.path, json, accessToken: token, clientSecret: s.clientSecret, publicKey: s.publicKey, now: new Date() });
  } catch (e) {
    // it never left: logged as not sent, and the caller hears the error as before
    logged.finish({ outcome: "not_sent", message: `The call couldn't be prepared (${e instanceof Error ? e.name : "error"}).`, requestMasked });
    throw e;
  }
  const url = `${i.settings.baseUrl.replace(/\/$/, "")}${i.op.path}`;
  const headers = {
    Authorization: `Bearer ${token}`, "Content-Type": "application/json", Host: i.settings.host, "X-PARTNER-ID": i.settings.partnerId, "CHANNEL-ID": i.settings.channelId,
    "X-EXTERNAL-ID": externalId, ...sealed.headers,
  };
  const body = i.op.method === "GET" ? null : sealed.body;
  full = { request: { method: i.op.method, url, headers: { ...headers, Authorization: `Bearer ${tokenTail(token)}` }, json: json || null, body }, response: null };
  let res: Response;
  logged.send();
  try {
    res = await fetch(url, { method: i.op.method, ...(body === null ? {} : { body }), signal: AbortSignal.timeout(i.op.timeoutMs), ...tlsOf(i.settings, s), headers });
  } catch (e) {
    const f = failure(e, i.op.timeoutMs);
    return done({ outcome: f.sent ? "timeout" : "not_sent", status: null, externalId, json: null, raw: null, message: f.message });
  }
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    full.response = { status: res.status, headers: headersOf(res.headers), raw: null, json: null };
    return done({ outcome: "timeout", status: res.status, externalId, json: null, raw: null, message: failure(e, i.op.timeoutMs).message });
  }
  const opened = openResponse(text, sealed.key, sealed.iv);
  full.response = { status: res.status, headers: headersOf(res.headers), raw: text, json: "json" in opened ? opened.json : null };
  if ("json" in opened) {
    return done({ outcome: res.ok ? "ok" : "rejected", status: res.status, externalId, json: opened.json, raw: null, message: res.ok ? "The bank answered." : `The bank refused it (HTTP ${res.status}).` });
  }
  const raw = text.slice(0, 2000);
  // a refusal before the operation ran (token, signature) comes back plain: refused, nothing booked
  if (res.status === 401 || res.status === 403) return done({ outcome: "rejected", status: res.status, externalId, json: null, raw, message: `The bank refused it (HTTP ${res.status}).` });
  return done({ outcome: "timeout", status: res.status, externalId, json: null, raw, message: `The bank answered ${res.status} and the answer could not be read.` });
}
