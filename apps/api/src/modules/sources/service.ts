// Sources: definitions, the encrypted connection, spec versions with maker-checker (in this module until the generic
// approvals module, Plan 5) and read-only shares, for /v1/spaces/:spaceId/sources*: 404 → rules → change → activity
// entry, one withSpace transaction per request. Row level security (drizzle/0011) bounds every query to the space and
// the sources shared to it; the queries also filter by space themselves, so an answer never depends on the role the
// pool connects as. A change locks the source row first, so changes to one source run one after the other.
import type { Page } from "@starterkit/shared/contracts/common";
import type { ActivityDto } from "@starterkit/shared/contracts/audit";
import type {
  ConnectionTestDto, CreateSourceBody, IngestListQuery, NewSourceTestBody, PreviewSourceBody, QueryColumnsBody, RejectSourceVersionBody, SetConnectionBody, SourceColumnsDto, SourceConnectionDto,
  SourceDto, SourceListQuery, SourceRowDto, SourceShareDto, SourceSummaryDto, SourcePreviewDto, SourceSpec, SourceVersionDetailDto, SourceVersionDto, SourceVersionListQuery,
  SourceCatalogBody, SourceCatalogDto, SourceVersionRowDto, TestConnectionBody, TypedConnection, UpdateSourceVersionBody,
} from "@starterkit/shared/contracts/sources";
import { SourceSpec as SourceSpecSchema } from "@starterkit/shared/contracts/sources";
import { amountUnit, type DbEngine, isLocalHost, type SourceKind, type SourceStateFilter, type SourceStatus, type VersionStatus } from "@starterkit/shared/sources";
import { and, asc, eq, exists, ilike, inArray, max, ne, not, or, type SQL, sql } from "drizzle-orm";
import { config } from "../../kernel/config";
import { decryptSecret, encryptSecret } from "../../kernel/crypto";
import type { InTx } from "../../kernel/db";
import { ApiError, isUniqueViolation, notFound, tooManyAttempts } from "../../kernel/errors";
import { isCron } from "../../kernel/jobs";
import { sourceFieldsLock } from "../../kernel/locks";
import { log } from "../../kernel/log";
import { likeEscape, one, pageQuery, sortSql } from "../../kernel/pagination";
import { recordActivity, targetActivityPage } from "../audit";
import { type Ctx, RateLimiter, retryText } from "../auth";
import {
  CATALOG_COUNT_CAP, type Column, type Connector, ConnectorError, connectorFor, DEFAULT_DATABASE, inboxProbe, previewRows, previewSample, scheduleSource, type Secret, type SourceState,
  sourceStates, specCelError, within,
} from "../ingest";
import { reconHealthInputs, reconsUsingFields } from "../recon";
import { spaceNames, spaces, withSpace } from "../spaces";
import { users } from "../users";
import {
  canStep, defaultRefused, fieldChanges, readsDifferently, shortVersion, specHash, specIssue, specWarnings, type TestFound, testFailure, testSentence, usedBySentence,
} from "./rules";
import { calendars, sourceConnections, sourceShares, sourceVersions, sources } from "./schema";

type SourceRow = typeof sources.$inferSelect;
type VersionRow = typeof sourceVersions.$inferSelect;

const NOW = sql`now()`;
const iso = (d: Date | null) => d?.toISOString() ?? null;

/** `fn` in a transaction that sees the caller's space (ctx.space, set by the space guard). */
const inSpace = <T>(ctx: Ctx, fn: (tx: InTx, spaceId: string) => Promise<T>) =>
  withSpace({ spaceIds: [ctx.space!.id], userId: ctx.user.id }, (tx) => fn(tx, ctx.space!.id));

type Owners = Map<string, string>;
const rowDto = (s: SourceRow, publishedVersion: number | null, spaceId: string, owners: Owners, state: SourceState | undefined): SourceRowDto => ({
  id: s.id, spaceId: s.spaceId, code: s.code, name: s.name, kind: s.kind as SourceKind, status: s.status as SourceStatus,
  shared: s.spaceId !== spaceId, publishedVersion,
  owner: s.spaceId !== spaceId ? { spaceId: s.spaceId, name: owners.get(s.spaceId) ?? "" } : null,
  health: state?.health ? omitInputs(state.health) : null, rowsToday: state?.rowsToday ?? null, quarantinedToday: state?.quarantinedToday ?? null,
  createdAt: s.createdAt.toISOString(), updatedAt: s.updatedAt.toISOString(),
});
/** The list's health: the detail's without the inputs it was judged on. */
const omitInputs = ({ graceMinutes: _g, deadline: _d, ...h }: NonNullable<SourceState["health"]>) => h;
/** What the screens show of `list` (ingest's read model) and the names of the spaces that own the shared ones. */
async function readModel(tx: InTx, list: { s: SourceRow; spec: unknown }[], spaceId: string) {
  const states = await sourceStates(tx, list.map(({ s, spec }) => ({
    id: s.id, spaceId: s.spaceId, kind: s.kind as SourceKind, status: s.status as SourceStatus, spec: (spec ?? null) as SourceSpec | null,
  })), spaceId, new Date(), await reconHealthInputs(tx, list.map(({ s }) => s.id)));
  const owners = await spaceNames(tx, list.filter(({ s }) => s.spaceId !== spaceId).map(({ s }) => s.spaceId));
  return { states, owners };
}
const versionDto = (v: VersionRow): SourceVersionDto => ({
  id: v.id, version: v.version, status: v.status as VersionStatus, spec: v.spec as SourceSpec | null, specHash: v.specHash,
  makerId: v.makerId, contributorIds: v.contributorIds, submitterId: v.submittedBy, submittedAt: iso(v.submittedAt), checkerId: v.checkerId,
  reviewComment: v.reviewComment, publishedAt: iso(v.publishedAt), warnings: specWarnings(v.spec as SourceSpec | null),
  createdAt: v.createdAt.toISOString(), updatedAt: v.updatedAt.toISOString(),
});
/** The connection's answerable columns: the credential (secret_enc) is never selected for an answer. */
const connectionColumns = { engine: sourceConnections.engine, options: sourceConnections.options, updatedAt: sourceConnections.updatedAt };
const connectionDto = (c: { engine: string; options: unknown; updatedAt: Date }): SourceConnectionDto =>
  ({ engine: c.engine, options: c.options, updatedAt: c.updatedAt.toISOString() }) as SourceConnectionDto;
const target = (s: SourceRow) => ({ type: "source", id: s.id, label: s.name });

/** Sources `spaceId` may read: its own, and those shared to it (the same rule as the RLS policies). */
const visibleIn = (tx: InTx, spaceId: string): SQL => or(eq(sources.spaceId, spaceId), exists(tx.select(one).from(sourceShares).where(and(
  eq(sourceShares.spaceId, sources.spaceId), eq(sourceShares.sourceId, sources.id), eq(sourceShares.toSpaceId, spaceId)))))!;
/** The versions of source `s`. */
const ofSource = (s: SourceRow) => and(eq(sourceVersions.spaceId, s.spaceId), eq(sourceVersions.sourceId, s.id));

/** The SOURCE_STATE_FILTERS state of a source (sourceStatus's rule, apps/web/src/lib/shared/source-status.ts). */
const stateOf = (s: SourceRow, published: number | null, health: { state: string } | null | undefined): SourceStateFilter =>
  published === null ? "draft" : s.status === "paused" ? "paused" : health?.state === "healthy" ? "healthy" : "attention";

/**
 * One page of the sources the space may read (its own and those shared to it), name A–Z unless `sort` says otherwise;
 * `state` keeps those of one SOURCE_STATE_FILTERS state. Draft and paused are columns; healthy and attention are the
 * health judged now, so for them every candidate is judged and the page cut after. ponytail: fine for the tens of
 * sources a space reads; a stored health column if a space grows to thousands.
 */
export function sourcePage(ctx: Ctx, q: SourceListQuery): Promise<Page<SourceRowDto>> {
  return inSpace(ctx, async (tx, spaceId) => {
    const like = q.q?.trim() ? `%${likeEscape(q.q.trim())}%` : null;
    // at most one published version per source (source_versions_published_key)
    const published = and(eq(sourceVersions.spaceId, sources.spaceId), eq(sourceVersions.sourceId, sources.id), eq(sourceVersions.status, "published"));
    const hasPublished = exists(tx.select(one).from(sourceVersions).where(published));
    const byState: Record<SourceStateFilter, SQL | undefined> = {
      draft: not(hasPublished), paused: and(hasPublished, eq(sources.status, "paused")),
      healthy: and(hasPublished, ne(sources.status, "paused")), attention: and(hasPublished, ne(sources.status, "paused")),
    };
    const where = and(visibleIn(tx, spaceId), like ? or(ilike(sources.code, like), ilike(sources.name, like)) : undefined, q.state ? byState[q.state] : undefined);
    const rows = tx.select({ s: sources, published: sourceVersions.version, spec: sourceVersions.spec }).from(sources).leftJoin(sourceVersions, published).where(where).$dynamic();
    const orderBy = sortSql(q.sort, { name: sql`lower(${sources.name})`, createdAt: sources.createdAt }, "name", sources.id);
    if (q.state === "healthy" || q.state === "attention") {
      const all = await rows.orderBy(...orderBy);
      const { states, owners } = await readModel(tx, all, spaceId);
      const kept = all.filter((r) => stateOf(r.s, r.published, states.get(r.s.id)?.health) === q.state);
      const items = kept.slice((q.page - 1) * q.pageSize, q.page * q.pageSize);
      return { items: items.map((r) => rowDto(r.s, r.published, spaceId, owners, states.get(r.s.id))), total: kept.length, page: q.page, pageSize: q.pageSize };
    }
    const page = await pageQuery({ rows, count: tx.select(one).from(sources).where(where).$dynamic(), orderBy, query: q, map: (r) => r, on: tx });
    const { states, owners } = await readModel(tx, page.items, spaceId);
    return { ...page, items: page.items.map((r) => rowDto(r.s, r.published, spaceId, owners, states.get(r.s.id))) };
  });
}

/** GET …/sources/summary: the sources the space may read, counted per SOURCE_STATE_FILTERS state (health judged now). */
export function sourceSummary(ctx: Ctx): Promise<SourceSummaryDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const published = and(eq(sourceVersions.spaceId, sources.spaceId), eq(sourceVersions.sourceId, sources.id), eq(sourceVersions.status, "published"));
    const all = await tx.select({ s: sources, published: sourceVersions.version, spec: sourceVersions.spec }).from(sources).leftJoin(sourceVersions, published).where(visibleIn(tx, spaceId));
    const { states } = await readModel(tx, all, spaceId);
    const out: SourceSummaryDto = { healthy: 0, attention: 0, paused: 0, draft: 0 };
    for (const r of all) out[stateOf(r.s, r.published, states.get(r.s.id)?.health)]++;
    return out;
  });
}

/**
 * The source with its published version; for the owner space also its open draft, connection (without the credential)
 * and shares. Through a share: the published version only.
 */
async function detailDto(tx: InTx, s: SourceRow, spaceId: string): Promise<SourceDto> {
  const own = s.spaceId === spaceId;
  const versions = await tx.select().from(sourceVersions)
    .where(and(ofSource(s), inArray(sourceVersions.status, own ? ["published", "draft", "in_review"] : ["published"])));
  const published = versions.find((v) => v.status === "published");
  const open = versions.find((v) => v.status !== "published");
  const [connection] = own ? await tx.select(connectionColumns).from(sourceConnections)
    .where(and(eq(sourceConnections.spaceId, s.spaceId), eq(sourceConnections.sourceId, s.id))) : [];
  // one row per space it is shared to: bounded by the number of spaces
  const shares: SourceShareDto[] = own ? await tx.select({ spaceId: spaces.id, code: spaces.code, name: spaces.name }).from(sourceShares)
    .innerJoin(spaces, eq(spaces.id, sourceShares.toSpaceId))
    .where(and(eq(sourceShares.spaceId, s.spaceId), eq(sourceShares.sourceId, s.id))).orderBy(asc(spaces.name)) : [];
  const { states, owners } = await readModel(tx, [{ s, spec: published?.spec }], spaceId);
  const state = states.get(s.id);
  return {
    ...rowDto(s, published?.version ?? null, spaceId, owners, state),
    health: state?.health ?? null,
    nextRunAt: state?.nextRunAt ?? null,
    drift: state?.drift ?? null,
    connection: connection ? connectionDto(connection) : null,
    shares,
    published: published ? versionDto(published) : null,
    draft: open ? versionDto(open) : null,
  };
}

/** GET /v1/spaces/:spaceId/sources/:sourceId; 404 for a source the space may not read. */
export function sourceDetail(ctx: Ctx, id: string): Promise<SourceDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    return detailDto(tx, await visibleSource(tx, spaceId, id), spaceId);
  });
}

/** Source `id` as `spaceId` may read it (its own, or shared to it); 404 otherwise. */
async function visibleSource(tx: InTx, spaceId: string, id: string): Promise<SourceRow> {
  const [s] = await tx.select().from(sources).where(and(eq(sources.id, id), visibleIn(tx, spaceId)));
  if (!s) throw notFound("source");
  return s;
}
/**
 * For a recon of `spaceId` (the recon module): each of `ids` the space may read, its own or shared to it (the same rule
 * as the RLS policies, checked here too), with its owner space, name and published spec (null before the first publish).
 * An id the space may not read is absent.
 */
export async function readableSources(tx: InTx, spaceId: string, ids: string[]): Promise<Map<string, { spaceId: string; name: string; spec: SourceSpec | null }>> {
  if (!ids.length) return new Map();
  const published = and(eq(sourceVersions.spaceId, sources.spaceId), eq(sourceVersions.sourceId, sources.id), eq(sourceVersions.status, "published"));
  const rows = await tx.select({ id: sources.id, spaceId: sources.spaceId, name: sources.name, spec: sourceVersions.spec }).from(sources)
    .leftJoin(sourceVersions, published).where(and(inArray(sources.id, ids), visibleIn(tx, spaceId)));
  return new Map(rows.map((r) => [r.id, { spaceId: r.spaceId, name: r.name, spec: (r.spec ?? null) as SourceSpec | null }]));
}

/** The versions a space reads of `s`: all of its own; through a share, the published and retired ones (as RLS 0011). */
const readable = (s: SourceRow, spaceId: string) => and(ofSource(s), s.spaceId === spaceId ? undefined : inArray(sourceVersions.status, ["published", "retired"]));
/** The names of `ids` (one query); a deleted user has none. */
async function namesOf(tx: InTx, ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return new Map();
  return new Map((await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, wanted))).map((u) => [u.id, u.name]));
}
const person = (names: Map<string, string>, id: string | null) => (id ? { id, name: names.get(id) ?? null } : null);

/** GET …/sources/:sourceId/versions: one page of its versions, newest first unless `sort` says otherwise. */
export function versionPage(ctx: Ctx, id: string, q: SourceVersionListQuery): Promise<Page<SourceVersionRowDto>> {
  return inSpace(ctx, async (tx, spaceId) => {
    const s = await visibleSource(tx, spaceId, id);
    const where = readable(s, spaceId);
    const page = await pageQuery({
      rows: tx.select().from(sourceVersions).where(where).$dynamic(),
      count: tx.select(one).from(sourceVersions).where(where).$dynamic(),
      orderBy: sortSql(q.sort, { version: sourceVersions.version, updatedAt: sourceVersions.updatedAt }, "-version", sourceVersions.id),
      query: q,
      map: (r) => r,
      on: tx,
    });
    const names = await namesOf(tx, page.items.flatMap((v) => [v.makerId, v.submittedBy, v.checkerId]));
    return {
      ...page,
      items: page.items.map((v): SourceVersionRowDto => ({
        id: v.id, version: v.version, status: v.status as VersionStatus, maker: person(names, v.makerId), submitter: person(names, v.submittedBy),
        checker: person(names, v.checkerId), reviewComment: v.reviewComment, submittedAt: iso(v.submittedAt), publishedAt: iso(v.publishedAt),
        createdAt: v.createdAt.toISOString(), updatedAt: v.updatedAt.toISOString(),
      })),
    };
  });
}

/** GET …/versions/:versionId: the version with the names of everyone it names; through a share, published or retired only. */
export function versionDetail(ctx: Ctx, id: string, versionId: string): Promise<SourceVersionDetailDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const s = await visibleSource(tx, spaceId, id);
    const [v] = await tx.select().from(sourceVersions).where(and(readable(s, spaceId), eq(sourceVersions.id, versionId)));
    if (!v) throw notFound("version");
    const ids = [...new Set([v.makerId, ...v.contributorIds, v.submittedBy, v.checkerId].filter((x): x is string => !!x))];
    const names = await namesOf(tx, ids);
    return { ...versionDto(v), people: ids.map((x) => person(names, x)!) };
  });
}

/**
 * GET …/sources/:sourceId/activity: the source's own trail (created, connection set, every version step, shares), newest
 * first, for any member of the owning space; 404 through a share. Read through the audit module (no global audit.view:
 * the trail belongs to the space's members). Snapshots are the masked ones recordActivity kept.
 */
export async function sourceActivity(ctx: Ctx, id: string, q: IngestListQuery): Promise<Page<ActivityDto>> {
  const s = await inSpace(ctx, async (tx, spaceId) => {
    const [row] = await tx.select().from(sources).where(and(eq(sources.id, id), eq(sources.spaceId, spaceId)));
    if (!row) throw notFound("source");
    return row;
  });
  return targetActivityPage({ type: "source", id: s.id }, q);
}

/** The space's own source `id`, row-locked; 404 when missing or only shared to this space (a share is read-only). */
async function ownSource(tx: InTx, spaceId: string, id: string): Promise<SourceRow> {
  const [s] = await tx.select().from(sources).where(and(eq(sources.id, id), eq(sources.spaceId, spaceId))).for("update");
  if (!s) throw notFound("source");
  return s;
}

/**
 * A new source, and in the same transaction a database source's connection and (`draft`) its first draft version,
 * each with its own activity entry. The code is unique in the space (409 before anything is made).
 */
export function createSource(ctx: Ctx, b: CreateSourceBody): Promise<SourceDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    if (b.connection && b.kind === "file_inbox") throw new ApiError("bad_request", "A file inbox source reads files, so it has no database connection.");
    let s: SourceRow;
    try {
      [s] = await tx.insert(sources).values({ id: Bun.randomUUIDv7(), spaceId, code: b.code, name: b.name, kind: b.kind }).returning() as [SourceRow];
    } catch (e) {
      // the only unique key a new id can hit is (space_id, code)
      throw isUniqueViolation(e) ? new ApiError("duplicate", "Another source in this space already has this code. Use a different one.") : e;
    }
    await recordActivity(tx, ctx, { action: "source.create", target: target(s), after: { code: s.code, name: s.name, kind: s.kind } });
    if (b.connection) await writeConnection(tx, ctx, s, b.connection);
    if (b.draft) await insertDraft(tx, ctx, s);
    return detailDto(tx, s, spaceId);
  });
}

/**
 * Replaces a DB source's connection: host, port, database, user and password encrypted together (kernel/crypto), the
 * options as they are. The answer and the `source.connection_set` entry carry the engine and options only.
 */
export function setConnection(ctx: Ctx, id: string, b: SetConnectionBody): Promise<SourceConnectionDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const s = await ownSource(tx, spaceId, id);
    if (s.kind === "file_inbox") throw new ApiError("bad_request", "A file inbox source reads files, so it has no database connection.");
    return writeConnection(tx, ctx, s, b);
  });
}

/** Stores source `s`'s connection (insert or replace) with its `source.connection_set` entry. */
async function writeConnection(tx: InTx, ctx: Ctx, s: SourceRow, b: SetConnectionBody): Promise<SourceConnectionDto> {
  const spaceId = s.spaceId, id = s.id;
  const of = and(eq(sourceConnections.spaceId, spaceId), eq(sourceConnections.sourceId, id));
  const [before] = await tx.select({ engine: sourceConnections.engine, options: sourceConnections.options }).from(sourceConnections).where(of);
  const { engine, options, host, port, database, user, password } = b;
  const secretEnc = encryptSecret(JSON.stringify({ host, port, database, user, password }));
  const [row] = await tx.insert(sourceConnections).values({ spaceId, sourceId: id, engine, options, secretEnc })
    .onConflictDoUpdate({ target: [sourceConnections.spaceId, sourceConnections.sourceId], set: { engine, options, secretEnc, updatedAt: NOW } })
    .returning(connectionColumns);
  // TLS off to a host that isn't this machine is the user's confirmed choice (REC-F2b): the entry names the host
  const tlsOff = !options.tls && !isLocalHost(host) ? { tlsOff: { host } } : {};
  await recordActivity(tx, ctx, { action: "source.connection_set", target: target(s), before: before ?? null, after: { engine, options, ...tlsOff } });
  return connectionDto(row!);
}

/** Version `versionId` of source `s`; 404 when it is not one. */
async function versionOf(tx: InTx, s: SourceRow, versionId: string): Promise<VersionRow> {
  const [v] = await tx.select().from(sourceVersions).where(and(ofSource(s), eq(sourceVersions.id, versionId)));
  if (!v) throw notFound("version");
  return v;
}

const wrongState = (text: string) => new ApiError("invalid_state", text);
/** The version's contributors plus the caller, once each, in order (the source row lock serializes writers). */
const withCaller = (ctx: Ctx, v: VersionRow): string[] => (v.contributorIds.includes(ctx.user.id) ? v.contributorIds : [...v.contributorIds, ctx.user.id]);

/**
 * A new draft (version = last + 1) holding the published spec, or none before the first publish; the caller is its
 * maker and first contributor. 409 `duplicate` while the source has a draft or a version in review.
 */
export function createDraft(ctx: Ctx, id: string): Promise<SourceVersionDto> {
  return inSpace(ctx, async (tx, spaceId) => insertDraft(tx, ctx, await ownSource(tx, spaceId, id)));
}

/** The draft of createDraft, in the caller's transaction (source `s` locked or just made). */
async function insertDraft(tx: InTx, ctx: Ctx, s: SourceRow): Promise<SourceVersionDto> {
  const spaceId = s.spaceId, id = s.id;
  const live = await tx.select().from(sourceVersions).where(and(ofSource(s), inArray(sourceVersions.status, ["draft", "in_review", "published"])));
  if (live.some((v) => v.status !== "published")) throw new ApiError("duplicate", "This source already has a draft or a version in review. Finish that one first.");
  const from = live.find((v) => v.status === "published");
  const [last] = await tx.select({ n: max(sourceVersions.version) }).from(sourceVersions).where(ofSource(s));
  const [v] = await tx.insert(sourceVersions).values({
    id: Bun.randomUUIDv7(), spaceId, sourceId: id, version: (last?.n ?? 0) + 1, status: "draft",
    spec: from?.spec ?? null, specHash: from?.specHash ?? null, makerId: ctx.user.id, contributorIds: [ctx.user.id],
  }).returning() as [VersionRow];
  await recordActivity(tx, ctx, { action: "source.version_create", target: target(s), after: { version: v.version, from: from?.version ?? null } });
  return versionDto(v);
}

/** A body the contract refused: 400 naming the spec's field when its reason was written for a person, else as thrown. */
export function refusedSpec(e: unknown): never {
  const why = specIssue(e);
  throw why ? new ApiError("bad_request", why) : e;
}

/**
 * The checks a spec passes beyond its contract, for a save and an unsaved preview alike (400): its input is of the
 * source's kind, its calendar exists, every CEL expression compiles, a snapshot schedule is a cron.
 */
async function checkSpec(tx: InTx, s: SourceRow, spec: SourceSpec): Promise<void> {
  if (spec.input.kind !== s.kind) throw new ApiError("bad_request", `This source's kind is ${s.kind}; its spec's input must be of that kind.`);
  const [calendar] = await tx.select({ id: calendars.id }).from(calendars).where(eq(calendars.code, spec.calendar));
  if (!calendar) throw new ApiError("bad_request", `There is no calendar ${spec.calendar}. Pick one of the calendars set up for this install.`);
  const celError = specCelError(spec);
  if (celError) throw new ApiError("bad_request", `Check the expression at ${celError}`);
  if (spec.input.kind === "db_snapshot" && !(await isCron(spec.input.schedule))) {
    throw new ApiError("bad_request", "The snapshot schedule is not a cron expression (minute hour day month weekday, Asia/Jakarta).");
  }
}

/** The input of a stored spec as the contract reads it (defaults filled in, so a seeded spec compares like a saved one). */
const inputOf = (spec: unknown): unknown => {
  const r = SourceSpecSchema.safeParse(spec);
  return r.success ? r.data.input : (spec as { input?: unknown } | null)?.input ?? null;
};

/**
 * How the source is read (`input`: table, query, watermark, schedule, folder, pattern, file format) is a source admin's
 * (spec §7 step 3a); a config maker sends it as saved: the version's own, else the published version's. 400 otherwise.
 */
async function sameReading(tx: InTx, ctx: Ctx, s: SourceRow, v: VersionRow, next: SourceSpec): Promise<void> {
  if (ctx.space!.roles.includes("source_admin")) return;
  let saved = v.spec ? inputOf(v.spec) : null;
  if (saved === null) {
    const [p] = await tx.select({ spec: sourceVersions.spec }).from(sourceVersions).where(and(ofSource(s), eq(sourceVersions.status, "published")));
    saved = p?.spec ? inputOf(p.spec) : null;
  }
  if (readsDifferently(next.input, saved)) throw new ApiError("bad_request", "Only a source admin changes how the source is read.");
}

/**
 * Saves a draft's whole spec; the caller becomes its maker (who last wrote the spec) and a contributor. The spec's input
 * must be of the source's kind and its calendar must exist (400). The same spec again: the version as it is, no entry.
 */
export function updateVersion(ctx: Ctx, id: string, versionId: string, b: UpdateSourceVersionBody): Promise<SourceVersionDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const s = await ownSource(tx, spaceId, id);
    const v = await versionOf(tx, s, versionId);
    if (!canStep("edit", v.status as VersionStatus)) throw wrongState("Only a draft can be edited. Make a new draft from the published version.");
    await checkSpec(tx, s, b.spec);
    await sameReading(tx, ctx, s, v, b.spec);
    const hash = specHash(b.spec);
    if (hash === v.specHash) return versionDto(v);
    const [row] = await tx.update(sourceVersions).set({ spec: b.spec, specHash: hash, makerId: ctx.user.id, contributorIds: withCaller(ctx, v), updatedAt: NOW })
      .where(eq(sourceVersions.id, v.id)).returning() as [VersionRow];
    await recordActivity(tx, ctx, { action: "source.version_update", target: target(s), before: { version: v.version, specHash: v.specHash }, after: { version: v.version, specHash: hash } });
    return versionDto(row);
  });
}

/**
 * A connector call someone waits on (connection test, columns, a database preview) finishes within this many seconds,
 * connect included: the web's backend client gives up after 10 s (apps/web/src/lib/server/backend.ts), so a slower
 * answer would reach the user as a bare 500.
 */
export const INTERACTIVE_SECONDS = 8;
/** Rows a database preview pulls at most. */
export const PREVIEW_PULL_ROWS = 200;

type StoredConnection = { engine: string; options: unknown; secretEnc: string };

/** The source's stored connection with its credential (only ever decrypted into a connector); null when none is set. */
async function storedConnection(tx: InTx, s: SourceRow): Promise<StoredConnection | null> {
  const [c] = await tx.select({ engine: sourceConnections.engine, options: sourceConnections.options, secretEnc: sourceConnections.secretEnc })
    .from(sourceConnections).where(and(eq(sourceConnections.spaceId, s.spaceId), eq(sourceConnections.sourceId, s.id)));
  return c ?? null;
}
const noConnection = () => new ApiError("bad_request", "This source has no connection yet. Set it first.");

/** What a connector call runs over: the engine, the credential, the options; `typed` = values on screen, not the stored ones. */
type Target = { engine: DbEngine; secret: Secret; options: { tls: boolean; connectTimeoutSeconds: number }; typed: boolean; defaulted: string | null };

const storedTarget = (c: StoredConnection): Target =>
  ({ engine: c.engine as DbEngine, secret: JSON.parse(decryptSecret(c.secretEnc)) as Secret, options: c.options as Target["options"], typed: false, defaulted: null });

/**
 * The connection a test or list runs over, as typed: an empty database is the engine's default (Oracle needs its service
 * name); a password left out is the stored one only when engine, host, port, database and user all equal the stored
 * connection (PO REC-F2a: the stored password never goes to other settings), else 400.
 */
function typedTarget(c: TypedConnection, stored: StoredConnection | null): Target {
  const fallback = c.database ? null : DEFAULT_DATABASE[c.engine];
  if (fallback === null && !c.database) throw new ApiError("bad_request", "Enter the service name: Oracle can't list its services before signing in.");
  const secret: Secret = { host: c.host, port: c.port, database: c.database || fallback!, user: c.user, password: c.password ?? "" };
  if (!secret.password) {
    const s = stored ? storedTarget(stored) : null;
    const same = s && s.engine === c.engine && (["host", "port", "database", "user"] as const).every((k) => s.secret[k] === secret[k]);
    if (!same) throw new ApiError("bad_request", stored ? "Type the password again to connect with the changed settings." : "Enter the password.");
    secret.password = s.secret.password;
  }
  return { engine: c.engine, secret, options: c.options, typed: true, defaulted: c.database ? null : secret.database };
}

/** A connector over `t` with the interactive timeouts; called after the transaction that read a stored one ended. */
function connectorOf(t: Target): Connector {
  return connectorFor(t.engine, t.secret, { tls: t.options.tls, connectTimeoutSeconds: Math.min(t.options.connectTimeoutSeconds, INTERACTIVE_SECONDS), statementTimeoutMs: INTERACTIVE_SECONDS * 1000 });
}
/** A connector over the stored connection, with the interactive timeouts. */
const interactiveConnector = (c: StoredConnection): Connector => connectorOf(storedTarget(c));

/** A connector failure's sentence; on the engine's default database (nothing typed), a refusal of that database says so. */
const failureText = (t: Target, e: ConnectorError) => (t.defaulted && (e.kind === "database" || e.kind === "query") ? defaultRefused(t.defaulted, e.code) : e.message);

/**
 * What a passing test can say about the server (REC-F2a): version and login, the databases (Oracle: schemas) and the
 * tables in the connected database, each read while time is left before `until`; what isn't read in time is left out
 * rather than failing the test. Never connects to another database to count.
 */
async function found(x: Connector, t: Target, until: number): Promise<TestFound> {
  const f: TestFound = { version: null, user: null, database: null, defaulted: t.defaulted !== null, databases: null, tables: null };
  const work = (async () => {
    const s = await x.server();
    Object.assign(f, { version: s.version || null, user: t.typed ? s.user || null : null, database: s.database || null });
    const d = await x.databases();
    f.databases = { n: d.names.length, more: d.truncated };
    if (t.engine !== "oracle" && t.defaulted === null && f.database) {
      const n = await x.countTables({}, CATALOG_COUNT_CAP + 1);
      f.tables = { n: Math.min(n, CATALOG_COUNT_CAP), more: n > CATALOG_COUNT_CAP };
    }
  })().catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise<void>((r) => { timer = setTimeout(r, Math.max(0, until - Date.now())); })]);
  clearTimeout(timer);
  return { ...f };
}

/**
 * Connects over `t` and runs SELECT 1, then says what it found: ok, or the failure's fixed sentence and driver code. A
 * test reaches any host and port from inside the bank network, so each one logs who tried which engine, host and port
 * and the result kind; never the login, the password or the error's text.
 */
async function probe(ctx: Ctx, t: Target): Promise<ConnectionTestDto> {
  let result = "error";
  const until = Date.now() + (INTERACTIVE_SECONDS - 1) * 1000;
  try {
    const f = await within(connectorOf(t), INTERACTIVE_SECONDS, async (x) => { await x.test(); return found(x, t, until); });
    result = "ok";
    return { ok: true, message: testSentence(t.engine, f), code: null, field: null, version: f.version ? shortVersion(t.engine, f.version) : null };
  } catch (e) {
    if (!(e instanceof ConnectorError)) throw e;
    result = e.kind;
    if (t.defaulted && (e.kind === "database" || e.kind === "query")) return { ok: false, message: defaultRefused(t.defaulted, e.code), code: e.code, field: "database", version: null };
    const at = t.typed ? { engine: t.engine, host: t.secret.host, port: t.secret.port, user: t.secret.user, database: t.secret.database } : null;
    return { ok: false, ...testFailure(e, at, e.seconds ?? Math.min(t.options.connectTimeoutSeconds, INTERACTIVE_SECONDS)), code: e.code, version: null };
  } finally {
    log.info({ userId: ctx.user.id, spaceId: ctx.space!.id, engine: t.engine, host: t.secret.host, port: t.secret.port, result }, "source connection test");
  }
}

/** Connection and folder tests: 20 a minute per user across both test routes (shared in PostgreSQL by every API process). */
const connectionTests = new RateLimiter("source-connection-test", 20, 60_000);
/** Catalog lists and searches (REC-F2a): 60 a minute per user, apart from the tests, so searching never locks Test out. */
const catalogLists = new RateLimiter("source-catalog", 60, 60_000);
async function limited(l: RateLimiter, ctx: Ctx): Promise<void> {
  const wait = await l.hit(ctx.user.id);
  if (wait !== null) throw tooManyAttempts(wait, retryText(wait));
}
/** `fn` over the stored connection; a connector failure is 400 with its fixed sentence. */
async function overConnection<T>(c: StoredConnection, fn: (x: Connector) => Promise<T>): Promise<T> {
  try {
    return await within(interactiveConnector(c), INTERACTIVE_SECONDS, fn);
  } catch (e) {
    throw e instanceof ConnectorError ? new ApiError("bad_request", e.message) : e;
  }
}

/** The spec being worked on (the open draft or version in review), else the published one, else null. */
async function workingSpec(tx: InTx, s: SourceRow): Promise<SourceSpec | null> {
  const vs = await tx.select({ status: sourceVersions.status, spec: sourceVersions.spec }).from(sourceVersions)
    .where(and(ofSource(s), inArray(sourceVersions.status, ["draft", "in_review", "published"])));
  return ((vs.find((v) => v.status !== "published") ?? vs[0])?.spec as SourceSpec | null | undefined) ?? null;
}

/**
 * POST …/connection/test: a database source connects with its stored credential (or the typed one, a password left out
 * only for the stored settings unchanged) and runs SELECT 1; a file inbox source reads the folder in the body (else the
 * spec being worked on's) inside INBOX_ROOTS and counts the files its pattern matches. A failure answers ok false with
 * one fixed sentence and the driver's code, never its text. Changes nothing. 429 past 20 tests a minute per user (both
 * test routes).
 */
export async function testConnection(ctx: Ctx, id: string, b: TestConnectionBody): Promise<ConnectionTestDto> {
  await limited(connectionTests, ctx);
  const got = await inSpace(ctx, async (tx, spaceId) => {
    const s = await ownSource(tx, spaceId, id);
    if (s.kind !== "file_inbox" && b.path !== undefined) throw new ApiError("bad_request", "A database source tests a connection: send no folder.");
    if (s.kind === "file_inbox" && b.connection) throw new ApiError("bad_request", "A file inbox source reads files, so it has no database connection.");
    return s.kind === "file_inbox" ? { spec: b.path === undefined ? await workingSpec(tx, s) : null } : { conn: await storedConnection(tx, s) };
  });
  if ("spec" in got) {
    const input = b.path !== undefined ? { path: b.path, pattern: b.pattern! } : got.spec?.input.kind === "file_inbox" ? got.spec.input : null;
    if (!input) throw new ApiError("bad_request", "This source has no folder yet. Enter the folder and the pattern, then test.");
    return { ...(await inboxProbe(config().INBOX_ROOTS, input.path, input.pattern)), code: null, field: null, version: null };
  }
  if (b.connection) return probe(ctx, typedTarget(b.connection, got.conn));
  if (!got.conn) throw noConnection();
  return probe(ctx, storedTarget(got.conn));
}

/**
 * POST /v1/spaces/:spaceId/sources/connection-test: a new source's folder or connection as typed, tried before the
 * source exists (nothing is stored); the same checks and deadline as the test of a stored one.
 */
export async function testNewSource(ctx: Ctx, b: NewSourceTestBody): Promise<ConnectionTestDto> {
  // the space guard (source_admin) is the whole authorization: nothing of the space is read
  await limited(connectionTests, ctx);
  if (b.kind === "file_inbox") return { ...(await inboxProbe(config().INBOX_ROOTS, b.path, b.pattern)), code: null, field: null, version: null };
  return probe(ctx, typedTarget(b.connection, null));
}

/**
 * POST …/sources/catalog and POST …/{sourceId}/connection/catalog (REC-F2a): what the source database lists for this
 * login, over the typed connection or the stored one: the databases it can open (Oracle: schemas), a page of the tables
 * and views it can SELECT, one table's columns, or the columns a typed SELECT gives (as …/connection/columns: the
 * query wrapped so it reads no row). Allowlisted catalog SQL only (connectors/dialect.ts), within the
 * interactive deadline; 429 past 60 lists a minute per user (apart from the tests); one log line per list, as a test's.
 * A connector failure is 400 with its fixed sentence.
 */
export async function sourceCatalog(ctx: Ctx, id: string | null, b: SourceCatalogBody): Promise<SourceCatalogDto> {
  await limited(catalogLists, ctx);
  const stored = id === null ? null : await inSpace(ctx, async (tx, spaceId) => {
    const s = await ownSource(tx, spaceId, id);
    if (s.kind === "file_inbox") throw new ApiError("bad_request", "A file inbox source has no tables.");
    return storedConnection(tx, s);
  });
  if (!b.connection && id === null) throw new ApiError("bad_request", "Send the connection to list what it can read.");
  if (!b.connection && !stored) throw noConnection();
  const t = b.connection ? typedTarget(b.connection, stored) : storedTarget(stored!);
  if (b.list === "tables" && t.defaulted !== null) throw new ApiError("bad_request", "Choose the database first: tables are listed per database.");
  let result = "error";
  try {
    const answer = await within(connectorOf(t), INTERACTIVE_SECONDS, async (x): Promise<SourceCatalogDto> => {
      if (b.list === "databases") {
        const d = await x.databases();
        return { list: "databases", items: d.names, truncated: d.truncated };
      }
      if (b.list === "columns") return { list: "columns", table: b.table, columns: (await x.introspect({ table: b.table })).map(columnDto) };
      if (b.list === "query") return { list: "query", columns: (await x.introspect({ query: b.query, businessDate: b.businessDate ?? todayJakarta() })).map(columnDto) };
      const f = { ...(b.schema !== undefined ? { schema: b.schema } : {}), ...(b.q ? { q: b.q } : {}) };
      const page = await x.tables({ ...f, ...(b.after ? { after: b.after } : {}) });
      const n = await x.countTables(f, CATALOG_COUNT_CAP + 1);
      return { list: "tables", items: page.items, total: Math.min(n, CATALOG_COUNT_CAP), totalCapped: n > CATALOG_COUNT_CAP, next: page.next };
    });
    result = "ok";
    return answer;
  } catch (e) {
    if (!(e instanceof ConnectorError)) throw e;
    result = e.kind;
    throw new ApiError("bad_request", failureText(t, e));
  } finally {
    log.info({ userId: ctx.user.id, spaceId: ctx.space!.id, engine: t.engine, host: t.secret.host, port: t.secret.port, list: b.list, result }, "source catalog list");
  }
}

/** A connector column as the API answers it (unique and indexed null when the engine didn't say). */
const columnDto = (c: Column) => ({ name: c.name, type: c.type, nullable: c.nullable, unique: c.unique ?? null, indexed: c.indexed ?? null });

/** GET …/connection/columns: the columns of `table` in the source database's catalog (400 when it has no such table). */
export async function sourceColumns(ctx: Ctx, id: string, table: string): Promise<SourceColumnsDto> {
  const conn = await inSpace(ctx, async (tx, spaceId) => {
    const s = await ownSource(tx, spaceId, id);
    if (s.kind === "file_inbox") throw new ApiError("bad_request", "A file inbox source has no tables.");
    return storedConnection(tx, s);
  });
  if (!conn) throw noConnection();
  return { table, columns: (await overConnection(conn, (c) => c.introspect({ table }))).map(columnDto) };
}

/** Today in Asia/Jakarta as yyyy-mm-dd: a snapshot preview's business date when the body names none. */
const todayJakarta = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());

/** POST …/connection/columns: the result columns of a SELECT, described by the source database (nullable unknown). */
export async function queryColumns(ctx: Ctx, id: string, b: QueryColumnsBody): Promise<SourceColumnsDto> {
  const conn = await inSpace(ctx, async (tx, spaceId) => {
    const s = await ownSource(tx, spaceId, id);
    if (s.kind === "file_inbox") throw new ApiError("bad_request", "A file inbox source has no tables.");
    return storedConnection(tx, s);
  });
  if (!conn) throw noConnection();
  return { table: null, columns: (await overConnection(conn, (c) => c.introspect({ query: b.query, businessDate: b.businessDate ?? todayJakarta() }))).map(columnDto) };
}

/**
 * What a sample gives under this version's spec: the rows that would enter the core record and the lines that would be
 * quarantined, with their reasons. A file source: the text sample in the body. A database source: up to
 * PREVIEW_PULL_ROWS rows pulled through the stored connection (watermark predicate left out; a snapshot query for the
 * body's business date). `b.spec` = unsaved edits, checked like a save, previewed in place of the saved spec. Reads only;
 * a version in any state with a spec.
 */
export async function previewVersion(ctx: Ctx, id: string, versionId: string, b: PreviewSourceBody): Promise<SourcePreviewDto> {
  const { spec, cal, conn } = await inSpace(ctx, async (tx, spaceId) => {
    const s = await ownSource(tx, spaceId, id);
    const v = await versionOf(tx, s, versionId);
    if (b.spec) {
      // a config checker previews the version as saved; unsaved edits are a maker's or a source admin's
      if (!ctx.space!.roles.some((r) => r === "source_admin" || r === "config_maker")) throw new ApiError("forbidden");
      await checkSpec(tx, s, b.spec);
      await sameReading(tx, ctx, s, v, b.spec);
    }
    const spec = b.spec ?? (v.spec as SourceSpec | null);
    if (spec === null) throw new ApiError("bad_request", "This version has no fields and mapping yet. Save them, then preview.");
    const [cal] = await tx.select({ weekend: calendars.weekend, holidays: calendars.holidays }).from(calendars).where(eq(calendars.code, spec.calendar));
    if (!cal) throw new ApiError("bad_request", `There is no calendar ${spec.calendar}. Pick one of the calendars set up for this install.`);
    return { spec, cal, conn: spec.input.kind === "file_inbox" ? null : await storedConnection(tx, s) };
  });
  const input = spec.input;
  if (input.kind === "file_inbox") {
    if (!("sample" in b)) throw new ApiError("bad_request", "Paste a sample of the file to preview it.");
    return previewSample(spec, b.sample, cal, b.fileName);
  }
  if ("sample" in b) throw new ApiError("bad_request", "A database source previews rows pulled through its connection: send no sample.");
  if (!conn) throw noConnection();
  const columns = spec.fields.map((f) => f.name);
  const rows = await overConnection(conn, (c) => input.kind === "db_snapshot"
    ? c.sample({ query: input.query, businessDate: b.businessDate ?? todayJakarta() }, columns, PREVIEW_PULL_ROWS)
    : c.sample(input.table !== undefined ? { table: input.table } : { query: input.query! }, columns, PREVIEW_PULL_ROWS));
  return previewRows(spec, rows, cal);
}

/**
 * 400 when version `v` drops or retypes a record field that a published recon reads from source `s` (Plan 3 A4), in
 * this space or one the source is shared to, naming the field and those recons. Under the source's fields lock, so a
 * recon published meanwhile is seen.
 */
async function keepsUsedFields(tx: InTx, s: SourceRow, v: VersionRow): Promise<void> {
  if (v.spec === null) return;
  await sourceFieldsLock(tx, s.id);
  const [p] = await tx.select({ spec: sourceVersions.spec }).from(sourceVersions).where(and(ofSource(s), eq(sourceVersions.status, "published")));
  if (!p?.spec) return;
  const changes = fieldChanges(p.spec as SourceSpec, v.spec as SourceSpec);
  if (!changes.length) return;
  const why = usedBySentence(changes, await reconsUsingFields(tx, s.id, changes.map((c) => c.ref)));
  if (why) throw new ApiError("bad_request", why);
}

/** Sends a draft with a spec to review; the caller becomes a contributor and its submitter. */
export function submitVersion(ctx: Ctx, id: string, versionId: string): Promise<SourceVersionDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const s = await ownSource(tx, spaceId, id);
    const v = await versionOf(tx, s, versionId);
    if (!canStep("submit", v.status as VersionStatus)) throw wrongState("Only a draft can be submitted.");
    if (v.spec === null) throw new ApiError("bad_request", "This draft has no fields and mapping yet. Save them, then submit.");
    await keepsUsedFields(tx, s, v);
    const [row] = await tx.update(sourceVersions).set({ status: "in_review", contributorIds: withCaller(ctx, v), submittedBy: ctx.user.id, submittedAt: NOW, updatedAt: NOW }).where(eq(sourceVersions.id, v.id)).returning() as [VersionRow];
    await recordActivity(tx, ctx, { action: "source.version_submit", target: target(s), after: { version: v.version, specHash: v.specHash } });
    return versionDto(row);
  });
}

/**
 * 409 `self_approval` when the caller created, edited or submitted the version (or is its maker): the checker is
 * always someone who had no hand in it (spec §11), so a trivial last edit by someone else can't clear the author.
 */
function notAContributor(ctx: Ctx, v: VersionRow): void {
  if (v.makerId === ctx.user.id || v.contributorIds.includes(ctx.user.id)) throw new ApiError("self_approval");
}

/**
 * Publishes a version in review; the published one before it retires (`amountUnit` in the entry when the amount's
 * unit changed: the records already stored keep theirs, the new unit reads the rows that arrive from now on). The source becomes active again (a source paused
 * because its columns changed is fixed by a new version, spec §7 step 4) and its pull is scheduled with the new spec.
 */
export function approveVersion(ctx: Ctx, id: string, versionId: string): Promise<SourceVersionDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const s = await ownSource(tx, spaceId, id);
    const v = await versionOf(tx, s, versionId);
    notAContributor(ctx, v);
    if (!canStep("approve", v.status as VersionStatus)) throw wrongState("Only a version in review can be approved.");
    await keepsUsedFields(tx, s, v);
    const [retired] = await tx.update(sourceVersions).set({ status: "retired", updatedAt: NOW })
      .where(and(ofSource(s), eq(sourceVersions.status, "published"))).returning({ version: sourceVersions.version, spec: sourceVersions.spec });
    const [row] = await tx.update(sourceVersions).set({ status: "published", checkerId: ctx.user.id, publishedAt: NOW, reviewComment: null, updatedAt: NOW })
      .where(eq(sourceVersions.id, v.id)).returning() as [VersionRow];
    if (s.status !== "active") await tx.update(sources).set({ status: "active", updatedAt: NOW }).where(eq(sources.id, s.id));
    await scheduleSource({ spaceId, sourceId: s.id }, row.spec as SourceSpec);
    // records keep the amount they were stored with (each names its source version); a new unit reads later rows only
    const unit = { before: retired?.spec ? amountUnit(retired.spec as SourceSpec) : null, after: amountUnit(row.spec as SourceSpec) };
    const unitChanged = retired?.spec && unit.before !== unit.after ? { amountUnit: unit } : {};
    await recordActivity(tx, ctx, { action: "source.version_approve", target: target(s), after: { version: v.version, specHash: v.specHash, retired: retired?.version ?? null, ...unitChanged } });
    return versionDto(row);
  });
}

/** Sends a version in review back to draft with the checker's comment; `checkerId` = who sent it back (approve overwrites it). */
export function rejectVersion(ctx: Ctx, id: string, versionId: string, b: RejectSourceVersionBody): Promise<SourceVersionDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const s = await ownSource(tx, spaceId, id);
    const v = await versionOf(tx, s, versionId);
    notAContributor(ctx, v);
    if (!canStep("reject", v.status as VersionStatus)) throw wrongState("Only a version in review can be rejected.");
    const [row] = await tx.update(sourceVersions).set({ status: "draft", reviewComment: b.comment, checkerId: ctx.user.id, updatedAt: NOW })
      .where(eq(sourceVersions.id, v.id)).returning() as [VersionRow];
    await recordActivity(tx, ctx, { action: "source.version_reject", target: target(s), after: { version: v.version, comment: b.comment } });
    return versionDto(row);
  });
}

/**
 * DELETE …/sources/:sourceId: a draft source nobody ever submitted (no version in review, published, retired or sent
 * back) and that is shared nowhere, with its connection and draft (cascade); `source.discard` in the same transaction.
 * Anything else is 409 invalid_state: a source with a history stays.
 */
export function discardSource(ctx: Ctx, id: string): Promise<void> {
  return inSpace(ctx, async (tx, spaceId) => {
    const s = await ownSource(tx, spaceId, id);
    const vs = await tx.select({ status: sourceVersions.status, submittedAt: sourceVersions.submittedAt }).from(sourceVersions).where(ofSource(s));
    const [share] = await tx.select({ to: sourceShares.toSpaceId }).from(sourceShares).where(and(eq(sourceShares.spaceId, spaceId), eq(sourceShares.sourceId, id))).limit(1);
    if (vs.some((v) => v.status !== "draft" || v.submittedAt !== null) || share) {
      throw wrongState("Only a source that was never submitted for approval or shared can be deleted. Its history stays.");
    }
    await tx.delete(sources).where(and(eq(sources.spaceId, spaceId), eq(sources.id, id)));
    await recordActivity(tx, ctx, { action: "source.discard", target: target(s), before: { code: s.code, name: s.name, kind: s.kind } });
  });
}

/** The space `toSpaceId` as a share answer; 400 for the source's own space, 404 for no such space. */
async function shareTarget(tx: InTx, spaceId: string, toSpaceId: string): Promise<SourceShareDto> {
  if (toSpaceId === spaceId) throw new ApiError("bad_request", "A source is always visible in its own space. Pick another space.");
  const [to] = await tx.select({ spaceId: spaces.id, code: spaces.code, name: spaces.name }).from(spaces).where(eq(spaces.id, toSpaceId));
  if (!to) throw notFound("space");
  return to;
}
const shareLog = (to: SourceShareDto) => ({ space: { id: to.spaceId, code: to.code, name: to.name } });

/** Shares the source read-only to another space; already shared → the share, no entry. */
export function shareSource(ctx: Ctx, id: string, toSpaceId: string): Promise<SourceShareDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const s = await ownSource(tx, spaceId, id);
    const to = await shareTarget(tx, spaceId, toSpaceId);
    const [made] = await tx.insert(sourceShares).values({ spaceId, sourceId: id, toSpaceId }).onConflictDoNothing().returning({ to: sourceShares.toSpaceId });
    if (made) await recordActivity(tx, ctx, { action: "source.share", target: target(s), after: shareLog(to) });
    return to;
  });
}

/** Ends a share; 404 when the source isn't shared to that space. */
export function unshareSource(ctx: Ctx, id: string, toSpaceId: string): Promise<void> {
  return inSpace(ctx, async (tx, spaceId) => {
    const s = await ownSource(tx, spaceId, id);
    const to = await shareTarget(tx, spaceId, toSpaceId);
    const gone = await tx.delete(sourceShares)
      .where(and(eq(sourceShares.spaceId, spaceId), eq(sourceShares.sourceId, id), eq(sourceShares.toSpaceId, toSpaceId))).returning({ to: sourceShares.toSpaceId });
    if (!gone.length) throw notFound("share");
    await recordActivity(tx, ctx, { action: "source.unshare", target: target(s), before: shareLog(to) });
  });
}

/**
 * Pauses source `sourceId` of `spaceId` (the ingest pipeline, when the source's columns no longer fit its spec): pulls
 * write nothing until a new version is approved. `tx` is the caller's withSpace transaction.
 */
export async function pauseSource(tx: InTx, spaceId: string, sourceId: string): Promise<void> {
  await tx.update(sources).set({ status: "paused", updatedAt: NOW }).where(and(eq(sources.spaceId, spaceId), eq(sources.id, sourceId)));
}
