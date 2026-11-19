// Sources: definitions, the encrypted connection, spec versions with maker-checker (in this module until the generic
// approvals module, Plan 5) and read-only shares, for /v1/spaces/:spaceId/sources*: 404 → rules → change → activity
// entry, one withSpace transaction per request. Row level security (drizzle/0011) bounds every query to the space and
// the sources shared to it; the queries also filter by space themselves, so an answer never depends on the role the
// pool connects as. A change locks the source row first, so changes to one source run one after the other.
import type { Page } from "@starterkit/shared/contracts/common";
import type {
  CreateSourceBody, RejectSourceVersionBody, SetConnectionBody, SourceConnectionDto, SourceDto, SourceListQuery, SourceRowDto, SourceShareDto,
  SourceSpec, SourceVersionDto, UpdateSourceVersionBody,
} from "@starterkit/shared/contracts/sources";
import type { SourceKind, SourceStatus, VersionStatus } from "@starterkit/shared/sources";
import { and, asc, eq, exists, ilike, inArray, max, or, type SQL, sql } from "drizzle-orm";
import { encryptSecret } from "../../kernel/crypto";
import type { InTx } from "../../kernel/db";
import { ApiError, isUniqueViolation, notFound } from "../../kernel/errors";
import { likeEscape, one, pageQuery, sortSql } from "../../kernel/pagination";
import { recordActivity } from "../audit";
import type { Ctx } from "../auth";
import { spaces, withSpace } from "../spaces";
import { canStep, specHash } from "./rules";
import { calendars, sourceConnections, sourceShares, sourceVersions, sources } from "./schema";

type SourceRow = typeof sources.$inferSelect;
type VersionRow = typeof sourceVersions.$inferSelect;

const NOW = sql`now()`;
const iso = (d: Date | null) => d?.toISOString() ?? null;

/** `fn` in a transaction that sees the caller's space (ctx.space, set by the space guard). */
const inSpace = <T>(ctx: Ctx, fn: (tx: InTx, spaceId: string) => Promise<T>) =>
  withSpace({ spaceIds: [ctx.space!.id], userId: ctx.user.id }, (tx) => fn(tx, ctx.space!.id));

const rowDto = (s: SourceRow, publishedVersion: number | null, spaceId: string): SourceRowDto => ({
  id: s.id, spaceId: s.spaceId, code: s.code, name: s.name, kind: s.kind as SourceKind, status: s.status as SourceStatus,
  shared: s.spaceId !== spaceId, publishedVersion, createdAt: s.createdAt.toISOString(), updatedAt: s.updatedAt.toISOString(),
});
const versionDto = (v: VersionRow): SourceVersionDto => ({
  id: v.id, version: v.version, status: v.status as VersionStatus, spec: v.spec as SourceSpec | null, specHash: v.specHash,
  makerId: v.makerId, checkerId: v.checkerId, reviewComment: v.reviewComment, publishedAt: iso(v.publishedAt),
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

/** One page of the sources the space may read (its own and those shared to it), name A–Z unless `sort` says otherwise. */
export function sourcePage(ctx: Ctx, q: SourceListQuery): Promise<Page<SourceRowDto>> {
  return inSpace(ctx, (tx, spaceId) => {
    const like = q.q?.trim() ? `%${likeEscape(q.q.trim())}%` : null;
    const where = and(visibleIn(tx, spaceId), like ? or(ilike(sources.code, like), ilike(sources.name, like)) : undefined);
    // at most one published version per source (source_versions_published_key)
    const published = and(eq(sourceVersions.spaceId, sources.spaceId), eq(sourceVersions.sourceId, sources.id), eq(sourceVersions.status, "published"));
    return pageQuery({
      rows: tx.select({ s: sources, published: sourceVersions.version }).from(sources).leftJoin(sourceVersions, published).where(where).$dynamic(),
      count: tx.select(one).from(sources).where(where).$dynamic(),
      orderBy: sortSql(q.sort, { name: sql`lower(${sources.name})`, createdAt: sources.createdAt }, "name", sources.id),
      query: q,
      map: (r) => rowDto(r.s, r.published, spaceId),
      on: tx,
    });
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
  return {
    ...rowDto(s, published?.version ?? null, spaceId),
    connection: connection ? connectionDto(connection) : null,
    shares,
    published: published ? versionDto(published) : null,
    draft: open ? versionDto(open) : null,
  };
}

/** GET /v1/spaces/:spaceId/sources/:sourceId; 404 for a source the space may not read. */
export function sourceDetail(ctx: Ctx, id: string): Promise<SourceDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const [s] = await tx.select().from(sources).where(and(eq(sources.id, id), visibleIn(tx, spaceId)));
    if (!s) throw notFound("source");
    return detailDto(tx, s, spaceId);
  });
}

/** The space's own source `id`, row-locked; 404 when missing or only shared to this space (a share is read-only). */
async function ownSource(tx: InTx, spaceId: string, id: string): Promise<SourceRow> {
  const [s] = await tx.select().from(sources).where(and(eq(sources.id, id), eq(sources.spaceId, spaceId))).for("update");
  if (!s) throw notFound("source");
  return s;
}

/** New source without connection or version; the code is unique in the space. */
export function createSource(ctx: Ctx, b: CreateSourceBody): Promise<SourceDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    let s: SourceRow;
    try {
      [s] = await tx.insert(sources).values({ id: Bun.randomUUIDv7(), spaceId, code: b.code, name: b.name, kind: b.kind }).returning() as [SourceRow];
    } catch (e) {
      // the only unique key a new id can hit is (space_id, code)
      throw isUniqueViolation(e) ? new ApiError("duplicate", "Another source in this space already has this code. Use a different one.") : e;
    }
    await recordActivity(tx, ctx, { action: "source.create", target: target(s), after: { code: s.code, name: s.name, kind: s.kind } });
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
    const of = and(eq(sourceConnections.spaceId, spaceId), eq(sourceConnections.sourceId, id));
    const [before] = await tx.select({ engine: sourceConnections.engine, options: sourceConnections.options }).from(sourceConnections).where(of);
    const { engine, options, host, port, database, user, password } = b;
    const secretEnc = encryptSecret(JSON.stringify({ host, port, database, user, password }));
    const [row] = await tx.insert(sourceConnections).values({ spaceId, sourceId: id, engine, options, secretEnc })
      .onConflictDoUpdate({ target: [sourceConnections.spaceId, sourceConnections.sourceId], set: { engine, options, secretEnc, updatedAt: NOW } })
      .returning(connectionColumns);
    await recordActivity(tx, ctx, { action: "source.connection_set", target: target(s), before: before ?? null, after: { engine, options } });
    return connectionDto(row!);
  });
}

/** Version `versionId` of source `s`; 404 when it is not one. */
async function versionOf(tx: InTx, s: SourceRow, versionId: string): Promise<VersionRow> {
  const [v] = await tx.select().from(sourceVersions).where(and(ofSource(s), eq(sourceVersions.id, versionId)));
  if (!v) throw notFound("version");
  return v;
}

const wrongState = (text: string) => new ApiError("invalid_state", text);

/**
 * A new draft (version = last + 1) holding the published spec, or none before the first publish; the caller is its
 * maker. 409 `duplicate` while the source has a draft or a version in review.
 */
export function createDraft(ctx: Ctx, id: string): Promise<SourceVersionDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const s = await ownSource(tx, spaceId, id);
    const live = await tx.select().from(sourceVersions).where(and(ofSource(s), inArray(sourceVersions.status, ["draft", "in_review", "published"])));
    if (live.some((v) => v.status !== "published")) throw new ApiError("duplicate", "This source already has a draft or a version in review. Finish that one first.");
    const from = live.find((v) => v.status === "published");
    const [last] = await tx.select({ n: max(sourceVersions.version) }).from(sourceVersions).where(ofSource(s));
    const [v] = await tx.insert(sourceVersions).values({
      id: Bun.randomUUIDv7(), spaceId, sourceId: id, version: (last?.n ?? 0) + 1, status: "draft",
      spec: from?.spec ?? null, specHash: from?.specHash ?? null, makerId: ctx.user.id,
    }).returning() as [VersionRow];
    await recordActivity(tx, ctx, { action: "source.version_create", target: target(s), after: { version: v.version, from: from?.version ?? null } });
    return versionDto(v);
  });
}

/**
 * Saves a draft's whole spec; the caller becomes its maker (who wrote the spec the checker reviews). The spec's input
 * must be of the source's kind and its calendar must exist (400). The same spec again: the version as it is, no entry.
 */
export function updateVersion(ctx: Ctx, id: string, versionId: string, b: UpdateSourceVersionBody): Promise<SourceVersionDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const s = await ownSource(tx, spaceId, id);
    const v = await versionOf(tx, s, versionId);
    if (!canStep("edit", v.status as VersionStatus)) throw wrongState("Only a draft can be edited. Make a new draft from the published version.");
    if (b.spec.input.kind !== s.kind) throw new ApiError("bad_request", `This source's kind is ${s.kind}; its spec's input must be of that kind.`);
    const [calendar] = await tx.select({ id: calendars.id }).from(calendars).where(eq(calendars.code, b.spec.calendar));
    if (!calendar) throw new ApiError("bad_request", `There is no calendar ${b.spec.calendar}. Pick one of the calendars set up for this install.`);
    const hash = specHash(b.spec);
    if (hash === v.specHash) return versionDto(v);
    const [row] = await tx.update(sourceVersions).set({ spec: b.spec, specHash: hash, makerId: ctx.user.id, updatedAt: NOW })
      .where(eq(sourceVersions.id, v.id)).returning() as [VersionRow];
    await recordActivity(tx, ctx, { action: "source.version_update", target: target(s), before: { version: v.version, specHash: v.specHash }, after: { version: v.version, specHash: hash } });
    return versionDto(row);
  });
}

/** Sends a draft with a spec to review. */
export function submitVersion(ctx: Ctx, id: string, versionId: string): Promise<SourceVersionDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const s = await ownSource(tx, spaceId, id);
    const v = await versionOf(tx, s, versionId);
    if (!canStep("submit", v.status as VersionStatus)) throw wrongState("Only a draft can be submitted.");
    if (v.spec === null) throw new ApiError("bad_request", "This draft has no fields and mapping yet. Save them, then submit.");
    const [row] = await tx.update(sourceVersions).set({ status: "in_review", updatedAt: NOW }).where(eq(sourceVersions.id, v.id)).returning() as [VersionRow];
    await recordActivity(tx, ctx, { action: "source.version_submit", target: target(s), after: { version: v.version, specHash: v.specHash } });
    return versionDto(row);
  });
}

/** 409 `self_approval` when the caller made the version: the checker is always someone else (spec §11). */
function notTheMaker(ctx: Ctx, v: VersionRow): void {
  if (v.makerId === ctx.user.id) throw new ApiError("self_approval");
}

/** Publishes a version in review; the published one before it retires. */
export function approveVersion(ctx: Ctx, id: string, versionId: string): Promise<SourceVersionDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const s = await ownSource(tx, spaceId, id);
    const v = await versionOf(tx, s, versionId);
    notTheMaker(ctx, v);
    if (!canStep("approve", v.status as VersionStatus)) throw wrongState("Only a version in review can be approved.");
    const [retired] = await tx.update(sourceVersions).set({ status: "retired", updatedAt: NOW })
      .where(and(ofSource(s), eq(sourceVersions.status, "published"))).returning({ version: sourceVersions.version });
    const [row] = await tx.update(sourceVersions).set({ status: "published", checkerId: ctx.user.id, publishedAt: NOW, reviewComment: null, updatedAt: NOW })
      .where(eq(sourceVersions.id, v.id)).returning() as [VersionRow];
    await recordActivity(tx, ctx, { action: "source.version_approve", target: target(s), after: { version: v.version, specHash: v.specHash, retired: retired?.version ?? null } });
    return versionDto(row);
  });
}

/** Sends a version in review back to draft with the checker's comment. */
export function rejectVersion(ctx: Ctx, id: string, versionId: string, b: RejectSourceVersionBody): Promise<SourceVersionDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const s = await ownSource(tx, spaceId, id);
    const v = await versionOf(tx, s, versionId);
    notTheMaker(ctx, v);
    if (!canStep("reject", v.status as VersionStatus)) throw wrongState("Only a version in review can be rejected.");
    const [row] = await tx.update(sourceVersions).set({ status: "draft", reviewComment: b.comment, updatedAt: NOW })
      .where(eq(sourceVersions.id, v.id)).returning() as [VersionRow];
    await recordActivity(tx, ctx, { action: "source.version_reject", target: target(s), after: { version: v.version, comment: b.comment } });
    return versionDto(row);
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
