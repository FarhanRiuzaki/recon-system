// The connector call log (spec 2026-11-24-connector-call-log-design): the transport builds one row per outbound call
// (CallDraft → recordCall) and writes it after the call, outside the send's transaction and without the send waiting
// for it; a failed write is a warning line and the send's result stands. Generic: the caller says where the call came
// from (CallOrigin) and on whose behalf. What is stored never holds the client secret, the Basic credential or a whole
// access token: the Authorization header and a token answer keep the token's last 8 characters, and every stored text
// is scrubbed of those values before it is written.
import type { Environment } from "@starterkit/shared/integrations";
import { encryptSecret } from "../../kernel/crypto";
import { db } from "../../kernel/db";
import { errorDetail } from "../../kernel/errors";
import { log } from "../../kernel/log";
import { connectorCalls } from "./schema";

/** Where a call came from, as its caller names it: `href` = the page of the thing it was for. */
export type CallOrigin = { module: string; kind: string; refId: string | null; label: string; href: string | null };
/** What the caller tells the log: origin, who (null = the system), on whose behalf, which attempt, the version used. */
export type CallMeta = { origin: CallOrigin; actorId: string | null; onBehalfOf?: string | null; attempt?: number; connectorVersion: number | null };
export type CallOutcome = "ok" | "rejected" | "timeout" | "not_sent";
/** The full call as stored (encrypted): every header as sent, the plain and the sealed body, the answer. */
export type FullCall = {
  request: { method: string; url: string; headers: Record<string, string>; json: string | null; body: string | null };
  response: { status: number; headers: Record<string, string>; raw: string | null; json: unknown } | null;
};

/** A raw answer kept in the full call: at most this many characters. */
const RAW_MAX = 64 * 1024;
/** A token as stored: its last 8 characters ("…a1b2c3d4"), nothing for a shorter one. */
export const tokenTail = (token: string): string => (token.length > 8 ? `…${token.slice(-8)}` : "…");

/** `text` without any of `secrets`: a token becomes its tail, anything else "(hidden)". */
function scrub(text: string, secrets: readonly { value: string; token?: true }[]): string {
  let out = text;
  for (const s of secrets) if (s.value.length >= 4) out = out.split(s.value).join(s.token ? tokenTail(s.value) : "(hidden)");
  return out;
}
const scrubJson = (v: unknown, secrets: Parameters<typeof scrub>[1]): unknown => (v === null || v === undefined ? null : JSON.parse(scrub(JSON.stringify(v), secrets)));

/** The host and path of a call (no query string); an address that isn't one gives an empty host. */
function where(baseUrl: string, path: string): { host: string; path: string } {
  const bare = path.split("?")[0]!;
  if (!baseUrl) return { host: "", path: bare };
  try {
    return { host: new URL(baseUrl).host, path: bare };
  } catch {
    return { host: "", path: bare };
  }
}

/** One call being made: started when built; `finish` turns it into a row and writes it (never throws). */
export class CallDraft {
  private readonly started = new Date();
  private readonly secrets: { value: string; token?: true }[] = [];
  constructor(private readonly i: { connectorId: string; env: Environment; meta: CallMeta; operationKey: string | null; method: string; baseUrl: string; path: string }) {}
  /** Values that must never be stored: the client secret, the Basic credential (plain), the access token (as its tail). */
  hide(value: string | undefined, token = false): this {
    if (value) this.secrets.push(token ? { value, token: true } : { value });
    return this;
  }
  finish(r: { outcome: CallOutcome; httpStatus?: number | null; code?: string | null; message: string; externalId?: string | null; requestMasked?: unknown; responseMasked?: unknown; full?: FullCall | null }): void {
    try {
      const at = where(this.i.baseUrl, this.i.path);
      const full = r.full ? { ...r.full, response: r.full.response ? { ...r.full.response, raw: r.full.response.raw?.slice(0, RAW_MAX) ?? null } : null } : null;
      recordCall({
        id: Bun.randomUUIDv7(), connectorId: this.i.connectorId, connectorVersion: this.i.meta.connectorVersion, environment: this.i.env, operationKey: this.i.operationKey,
        method: this.i.method, host: at.host, path: at.path, startedAt: this.started, durationMs: Date.now() - this.started.getTime(), attempt: this.i.meta.attempt ?? 1,
        outcome: r.outcome, httpStatus: r.httpStatus ?? null, code: r.code ?? null, message: scrub(r.message, this.secrets), externalId: r.externalId ?? null,
        requestMasked: scrubJson(r.requestMasked, this.secrets), responseMasked: scrubJson(r.responseMasked, this.secrets),
        fullEnc: full ? encryptSecret(scrub(JSON.stringify(full), this.secrets)) : null,
        origin: this.i.meta.origin, actorId: this.i.meta.actorId, onBehalfOf: this.i.meta.onBehalfOf ?? null,
      });
    } catch (e) {
      log.warn({ err: errorDetail(e) }, "connector call not logged");
    }
  }
}

const pending = new Set<Promise<void>>();
/** Writes the row on its own (not awaited by the send); a failure is a warning, never the send's error. */
function recordCall(row: typeof connectorCalls.$inferInsert): void {
  const p: Promise<void> = db.insert(connectorCalls).values(row).then(
    () => {},
    (e: unknown) => { log.warn({ err: errorDetail(e) }, "connector call not logged"); },
  ).finally(() => { pending.delete(p); });
  pending.add(p);
}
/** Resolves once every call row being written has been written (or failed): tests, and a clean shutdown. */
export const callsLogged = async (): Promise<void> => { await Promise.all([...pending]); };
