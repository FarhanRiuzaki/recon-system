// The connector call log (spec 2026-11-24-connector-call-log-design): the transport builds one row per outbound call
// (CallDraft → recordCall) and writes it after the call, outside the send's transaction and without the send waiting
// for it; a failed write is a warning line and the send's result stands. Generic: the caller says where the call came
// from (CallOrigin) and on whose behalf. What is stored never holds the client secret, the Basic credential or a whole
// access token: the Authorization header and a token answer keep the token's last 8 characters, and every stored text
// is scrubbed of those values before it is written.
import type { FacetsDto, Page } from "@starterkit/shared/contracts/common";
import type { CallListQuery, ConnectorCallDto, ConnectorCallFullDto, ConnectorCallRowDto, ConnectorSpec } from "@starterkit/shared/contracts/integrations";
import type { CallOutcome, Environment } from "@starterkit/shared/integrations";
import { APP_TIME_ZONE } from "@starterkit/ui/lib/format";
import { resolveTimeRange } from "@starterkit/ui/lib/time-range";
import { and, eq, ilike, inArray, isNotNull, lt, or, type SQL, sql } from "drizzle-orm";
import { config } from "../../kernel/config";
import { decryptSecret, encryptSecret } from "../../kernel/crypto";
import { db, type InTx, type Tx } from "../../kernel/db";
import { ApiError, errorDetail, notFound } from "../../kernel/errors";
import { log } from "../../kernel/log";
import { countN, facetOf, likeEscape, pageQuery, sortSql } from "../../kernel/pagination";
import { userNames } from "../approvals";
import { recordActivity } from "../audit";
import type { Ctx } from "../auth";
import { connectorCalls, connectors, connectorVersions } from "./schema";

/** Where a call came from, as its caller names it: `href` = the page of the thing it was for. */
export type CallOrigin = { module: string; kind: string; refId: string | null; label: string; href: string | null };
/** What the caller tells the log: origin, who (null = the system), on whose behalf, which attempt, the version used. */
export type CallMeta = { origin: CallOrigin; actorId: string | null; onBehalfOf?: string | null; attempt?: number; connectorVersion: number | null };
/** The full call as stored (encrypted): every header as sent, the plain and the sealed body, the answer. */
export type FullCall = {
  request: { method: string; url: string; headers: Record<string, string>; json: string | null; body: string | null };
  response: { status: number; headers: Record<string, string>; raw: string | null; json: unknown } | null;
};

/** A raw answer kept in the full call: at most this many characters. */
const RAW_MAX = 64 * 1024;
/** A token as stored: its last 8 characters ("…a1b2c3d4"), nothing for a shorter one. */
export const tokenTail = (token: string): string => (token.length > 8 ? `…${token.slice(-8)}` : "…");

const esc = (x: string) => JSON.stringify(x).slice(1, -1), slashed = (x: string) => x.replaceAll("/", "\\/");
/** The spellings a value can take in a stored text: as is, JSON-escaped, with `\/` (as a JSON writer may send it), and that escaped once more (inside the full call's JSON). */
const SPELLINGS: ((x: string) => string)[] = [(x) => x, esc, (x) => slashed(esc(x)), (x) => esc(slashed(esc(x)))];
/** `text` without any of `secrets` in any spelling: a token becomes its tail, anything else "(hidden)", spelled the same way. */
function scrub(text: string, secrets: readonly { value: string; token?: true }[]): string {
  let out = text;
  for (const s of secrets) {
    if (s.value.length < 4) continue;
    const shown = s.token ? tokenTail(s.value) : "(hidden)";
    for (const spell of SPELLINGS) out = out.split(spell(s.value)).join(spell(shown));
  }
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

/** One call being made: started when built (or at `send`); `finish` turns it into a row and writes it (never throws). */
export class CallDraft {
  private started = new Date();
  /** The request leaves now: its time and duration count from here (after its token request, which is a row of its own). */
  send(): void { this.started = new Date(); }
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

const c = connectorCalls;
/** The origin as a filter value: `module.kind`. */
const originKey = sql<string>`(${c.origin}->>'module') || '.' || (${c.origin}->>'kind')`;
/** The range as the logs read it: start–end (a time range), else from–to calendar days in the app time zone. */
function inRange(q: CallListQuery): SQL | undefined {
  const timed = q.start && q.end ? resolveTimeRange({ start: q.start, end: q.end }, Date.now()) : null;
  if (timed) return sql`${c.startedAt} >= ${new Date(timed.start)} and ${c.startedAt} < ${new Date(timed.end)}`;
  return q.from && q.to ? sql`${c.startedAt} >= (${q.from}::date)::timestamp at time zone ${APP_TIME_ZONE} and ${c.startedAt} < ((${q.to}::date + 1)::timestamp at time zone ${APP_TIME_ZONE})` : undefined;
}
function callsWhere(q: CallListQuery): SQL | undefined {
  const like = q.q ? `%${likeEscape(q.q)}%` : null;
  return and(
    inRange(q),
    q.connector ? eq(c.connectorId, q.connector) : undefined,
    q.environment?.length ? inArray(c.environment, q.environment) : undefined,
    q.outcome?.length ? inArray(c.outcome, q.outcome) : undefined,
    q.origin?.length ? inArray(originKey, q.origin) : undefined,
    like ? or(ilike(c.externalId, like), ilike(c.path, like), ilike(sql`${c.origin}->>'label'`, like)) : undefined,
  );
}
/** A row's columns, never `full_enc` (only whether it is still kept). */
const ROW = {
  id: c.id, connectorId: c.connectorId, connectorVersion: c.connectorVersion, environment: c.environment, operationKey: c.operationKey, method: c.method, host: c.host, path: c.path,
  startedAt: c.startedAt, durationMs: c.durationMs, attempt: c.attempt, outcome: c.outcome, httpStatus: c.httpStatus, code: c.code, message: c.message, externalId: c.externalId,
  origin: c.origin, actorId: c.actorId, onBehalfOf: c.onBehalfOf, full: sql<boolean>`${c.fullEnc} is not null`, connector: connectors.name,
};
const rowsOf = (tx: InTx, where: SQL | undefined) => tx.select(ROW).from(c).innerJoin(connectors, eq(connectors.id, c.connectorId)).where(where).$dynamic();
type Row = Awaited<ReturnType<typeof rowsOf>>[number];

/** The rows as answered: the operation's name from the version used, the people's names. */
async function toRows(tx: InTx, rows: readonly Row[]): Promise<ConnectorCallRowDto[]> {
  const pairs = [...new Set(rows.filter((r) => r.operationKey && r.connectorVersion !== null).map((r) => `${r.connectorId}:${r.connectorVersion}`))];
  const specs = pairs.length ? await tx.select({ connectorId: connectorVersions.connectorId, version: connectorVersions.version, spec: connectorVersions.spec }).from(connectorVersions)
    .where(or(...pairs.map((p) => { const [id, v] = p.split(":"); return and(eq(connectorVersions.connectorId, id!), eq(connectorVersions.version, Number(v))); }))) : [];
  const opName = (r: Row) => (specs.find((s) => s.connectorId === r.connectorId && s.version === r.connectorVersion)?.spec as ConnectorSpec | undefined)?.operations.find((o) => o.key === r.operationKey)?.name;
  const names = await userNames(tx, rows.flatMap((r) => [r.actorId, r.onBehalfOf]));
  const person = (id: string | null) => (id ? { id, name: names.get(id) ?? null } : null);
  return rows.map((r) => ({
    id: r.id, startedAt: r.startedAt.toISOString(), durationMs: r.durationMs, connector: { id: r.connectorId, name: r.connector }, version: r.connectorVersion,
    environment: r.environment as Environment, operation: r.operationKey ? { key: r.operationKey, name: opName(r) ?? r.operationKey } : null, method: r.method, host: r.host, path: r.path,
    outcome: r.outcome as CallOutcome, httpStatus: r.httpStatus, code: r.code, message: r.message, externalId: r.externalId, attempt: r.attempt,
    origin: r.origin as ConnectorCallRowDto["origin"], actor: person(r.actorId), onBehalfOf: person(r.onBehalfOf), full: r.full,
  }));
}

/** GET /integrations/calls: newest first. */
export function callPage(q: CallListQuery): Promise<Page<ConnectorCallRowDto>> {
  return db.transaction(async (tx) => {
    const where = callsWhere(q);
    const page = await pageQuery({
      rows: rowsOf(tx, where), count: tx.select({ id: c.id }).from(c).where(where).$dynamic(),
      orderBy: sortSql(q.sort, { startedAt: c.startedAt, durationMs: c.durationMs }, "-startedAt", c.id), query: q, map: (r) => r, on: tx,
    });
    return { ...page, items: await toRows(tx, page.items) };
  });
}

/** GET /integrations/calls/facets: per check filter, the counts with the other filters applied. */
export async function callFacets(q: CallListQuery): Promise<FacetsDto> {
  const [outcome, environment, origin] = await Promise.all([
    db.select({ v: c.outcome, n: countN }).from(c).where(callsWhere({ ...q, outcome: undefined })).groupBy(c.outcome),
    db.select({ v: c.environment, n: countN }).from(c).where(callsWhere({ ...q, environment: undefined })).groupBy(c.environment),
    db.select({ v: originKey, n: countN }).from(c).where(callsWhere({ ...q, origin: undefined })).groupBy(originKey),
  ]);
  return { outcome: facetOf(outcome), environment: facetOf(environment), origin: facetOf(origin) };
}

/** GET /integrations/calls/{id}: the row and its masked request and response. */
export function callDetail(id: string): Promise<ConnectorCallDto> {
  return db.transaction(async (tx) => {
    const [r] = await rowsOf(tx, eq(c.id, id));
    if (!r) throw notFound("call");
    const [m] = await tx.select({ request: c.requestMasked, response: c.responseMasked }).from(c).where(eq(c.id, id));
    return { ...(await toRows(tx, [r]))[0]!, request: m!.request ?? null, response: m!.response ?? null };
  });
}

/**
 * POST /integrations/calls/{id}/reveal (integration.debug): the full call, decrypted; the activity entry names the call,
 * never its content. 409 once the janitor has cleared it (CALL_LOG_FULL_RETENTION_DAYS).
 */
export function revealCall(ctx: Ctx, id: string): Promise<ConnectorCallFullDto> {
  return db.transaction(async (tx) => {
    const [r] = await tx.select({ fullEnc: c.fullEnc, connectorId: c.connectorId, operation: c.operationKey, name: connectors.name }).from(c).innerJoin(connectors, eq(connectors.id, c.connectorId)).where(eq(c.id, id));
    if (!r) throw notFound("call");
    if (!r.fullEnc) throw new ApiError("invalid_state", `The full request and response are kept for ${config().CALL_LOG_FULL_RETENTION_DAYS} days; this call's are no longer kept.`);
    const full = JSON.parse(decryptSecret(r.fullEnc)) as FullCall;
    await recordActivity(tx, ctx, { action: "integration.call_reveal", target: { type: "connector_call", id, label: `${r.name} · ${r.operation ?? "access token"}` }, after: { connectorId: r.connectorId, operation: r.operation } });
    return { id, request: full.request, response: full.response };
  });
}

const PURGE_BATCH = 10_000;
/**
 * Janitor: clears the full call of rows older than CALL_LOG_FULL_RETENTION_DAYS and deletes rows older than
 * CALL_LOG_RETENTION_DAYS, at most PURGE_BATCH each per run; answers how many.
 */
export async function purgeCalls(tx: Tx): Promise<Record<string, number>> {
  const ago = (days: number) => sql`now() - make_interval(days => ${days})`;
  // oldest first, on connector_calls_full_purge (full) or connector_calls_started: a batch never skips older rows
  const oldest = (days: number, full = false) => tx.select({ id: c.id }).from(c).where(and(lt(c.startedAt, ago(days)), full ? isNotNull(c.fullEnc) : undefined)).orderBy(c.startedAt).limit(PURGE_BATCH);
  const deleted = (await tx.delete(c).where(inArray(c.id, oldest(config().CALL_LOG_RETENTION_DAYS))).returning({ one: sql`1` })).length;
  const cleared = (await tx.update(c).set({ fullEnc: null }).where(inArray(c.id, oldest(config().CALL_LOG_FULL_RETENTION_DAYS, true))).returning({ one: sql`1` })).length;
  return { connector_calls: deleted, connector_calls_full: cleared };
}
