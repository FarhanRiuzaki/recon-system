// Recon configs: the config, its spec versions with maker-checker (in this module until the generic approvals module,
// Plan 5) and discard, for /v1/spaces/:spaceId/recons*: 404 → rules → change → activity entry, one withSpace
// transaction per request. Row level security (drizzle/0021) bounds every query to the space; the queries also filter
// by space themselves. A change locks the config row first, so changes to one config run one after the other. A side's
// source is one the space may read: its own or shared to it (DEC-042, readableSources in the sources module).
import type { Page } from "@starterkit/shared/contracts/common";
import type { ActivityDto } from "@starterkit/shared/contracts/audit";
import type {
  CreateReconBody, ReconActivityQuery, ReconDto, ReconListQuery, ReconRowDto, ReconSpec, ReconVersionDetailDto, ReconVersionDto, ReconVersionListQuery,
  ReconVersionRowDto, RejectReconVersionBody, UpdateReconVersionBody,
} from "@starterkit/shared/contracts/recon";
import type { ReconStatus } from "@starterkit/shared/recon";
import type { VersionStatus } from "@starterkit/shared/sources";
import { and, desc, eq, ilike, inArray, isNull, max, or, sql } from "drizzle-orm";
import type { InTx } from "../../kernel/db";
import { ApiError, isUniqueViolation, notFound } from "../../kernel/errors";
import { sourceFieldsLock } from "../../kernel/locks";
import { likeEscape, one, pageQuery, sortSql } from "../../kernel/pagination";
import { canStep, specHash } from "../../kernel/versions";
import { recordActivity, targetActivityPage } from "../audit";
import type { Ctx } from "../auth";
import { records } from "../ingest";
import { readableSources } from "../sources";
import { withSpace } from "../spaces";
import { users } from "../users";
import { checkReconSpec, placeOf, reconIssue, type SideSource, usedFields } from "./rules";
import { reconConfigs, reconConfigVersions, reconSourceUses } from "./schema";

type ConfigRow = typeof reconConfigs.$inferSelect;
type VersionRow = typeof reconConfigVersions.$inferSelect;

const NOW = sql`now()`;
const iso = (d: Date | null) => d?.toISOString() ?? null;
const target = (c: ConfigRow) => ({ type: "recon", id: c.id, label: c.name });
const wrongState = (text: string) => new ApiError("invalid_state", text);

/** `fn` in a transaction that sees the caller's space (ctx.space, set by the space guard). */
const inSpace = <T>(ctx: Ctx, fn: (tx: InTx, spaceId: string) => Promise<T>) =>
  withSpace({ spaceIds: [ctx.space!.id], userId: ctx.user.id }, (tx) => fn(tx, ctx.space!.id));

/** A body the contract refused: 400 naming the spot in the builder's words when its reason was written for a person. */
export function refusedRecon(e: unknown): never {
  const why = reconIssue(e);
  throw why ? new ApiError("bad_request", why) : e;
}

/**
 * Records a side's currency column is sampled over for the tolerance warning: the newest this many of the source.
 * ponytail: a currency seen only in older records gets no warning; a per-source currency list from ingest when it matters.
 */
const CURRENCY_SAMPLE = 10_000;

/** The sides' sources as the check reads them; `missing` = the sides whose source this space may not read. */
async function sideSources(tx: InTx, spaceId: string, spec: ReconSpec): Promise<{ sides: [SideSource, SideSource]; missing: number[]; owners: (string | null)[] }> {
  const found = await readableSources(tx, spaceId, [...new Set(spec.sides.map((s) => s.source_id))]);
  const sides = await Promise.all(spec.sides.map(async (side): Promise<SideSource> => {
    const src = found.get(side.source_id);
    if (!src?.spec) return { spec: null, currencies: [] };
    if (!src.spec.mapping.currency) return { spec: src.spec, currencies: [] };
    const recent = tx.select({ c: records.currency }).from(records)
      .where(and(eq(records.spaceId, src.spaceId), eq(records.sourceId, side.source_id), isNull(records.supersededBy)))
      .orderBy(desc(records.businessDate)).limit(CURRENCY_SAMPLE).as("recent");
    const seen = await tx.selectDistinct({ c: recent.c }).from(recent);
    return { spec: src.spec, currencies: seen.map((r) => r.c).filter((c): c is string => !!c) };
  }));
  const missing = spec.sides.flatMap((s, i) => (found.has(s.source_id) ? [] : [i]));
  return { sides: sides as [SideSource, SideSource], missing, owners: spec.sides.map((s) => found.get(s.source_id)?.spaceId ?? null) };
}

/**
 * The spec's check for a save, a submit and an approve: 400 for a side whose source the space can't read and for the
 * first error. `owners` = each side's source's space.
 */
async function checked(tx: InTx, spaceId: string, spec: ReconSpec) {
  const { sides, missing, owners } = await sideSources(tx, spaceId, spec);
  if (missing.length) throw new ApiError("bad_request", `${placeOf(["sides", missing[0]!])}: Pick a source of this space or one shared to it.`);
  const r = checkReconSpec(spec, sides);
  if (r.errors.length) throw new ApiError("bad_request", r.errors[0]!);
  return { ...r, owners, warnings: [...r.gates, ...r.warnings] };
}

/** What the check says now about a stored spec, never refusing: a lost source, errors, gates, then warnings. */
async function warningsOf(tx: InTx, spaceId: string, spec: ReconSpec): Promise<string[]> {
  const { sides, missing } = await sideSources(tx, spaceId, spec);
  const r = checkReconSpec(spec, sides);
  const lost = missing.map((i) => `${placeOf(["sides", i])}: This space can no longer read this side's source.`);
  const noSource = new Set(missing.map((i) => placeOf(["sides", i])));
  return [...lost, ...r.errors.filter((e) => ![...noSource].some((p) => e.startsWith(`${p}:`))), ...r.gates, ...r.warnings];
}

const versionDto = (v: VersionRow, warnings: string[]): ReconVersionDto => ({
  id: v.id, version: v.version, status: v.status as VersionStatus, spec: v.spec as ReconSpec, specHash: v.specHash,
  makerId: v.makerId, contributorIds: v.contributorIds, submitterId: v.submittedBy, submittedAt: iso(v.submittedAt), checkerId: v.checkerId,
  reviewComment: v.reviewComment, publishedAt: iso(v.publishedAt), simulatedHash: v.simulatedHash, warnings,
  createdAt: v.createdAt.toISOString(), updatedAt: v.updatedAt.toISOString(),
});
const withWarnings = async (tx: InTx, spaceId: string, v: VersionRow) => versionDto(v, await warningsOf(tx, spaceId, v.spec as ReconSpec));
const rowDto = (c: ConfigRow, publishedVersion: number | null): ReconRowDto => ({
  id: c.id, spaceId: c.spaceId, code: c.code, name: c.name, status: c.status as ReconStatus, publishedVersion, createdAt: c.createdAt.toISOString(),
});
const ofConfig = (c: ConfigRow) => and(eq(reconConfigVersions.spaceId, c.spaceId), eq(reconConfigVersions.configId, c.id));

/** The config with its published version and open draft (draft or in review), each with what its check says now. */
async function detailDto(tx: InTx, c: ConfigRow): Promise<ReconDto> {
  const vs = await tx.select().from(reconConfigVersions).where(and(ofConfig(c), inArray(reconConfigVersions.status, ["published", "draft", "in_review"])));
  const published = vs.find((v) => v.status === "published");
  const open = vs.find((v) => v.status !== "published");
  return {
    ...rowDto(c, published?.version ?? null),
    published: published ? await withWarnings(tx, c.spaceId, published) : null,
    draft: open ? await withWarnings(tx, c.spaceId, open) : null,
  };
}

/** The space's config `id`; 404 when it is not one. `lock` takes its row lock (every change does). */
async function configOf(tx: InTx, spaceId: string, id: string, lock = false): Promise<ConfigRow> {
  const q = tx.select().from(reconConfigs).where(and(eq(reconConfigs.id, id), eq(reconConfigs.spaceId, spaceId)));
  const [c] = lock ? await q.for("update") : await q;
  if (!c) throw notFound("recon");
  return c;
}
async function versionOf(tx: InTx, c: ConfigRow, versionId: string): Promise<VersionRow> {
  const [v] = await tx.select().from(reconConfigVersions).where(and(ofConfig(c), eq(reconConfigVersions.id, versionId)));
  if (!v) throw notFound("version");
  return v;
}
/** The version's contributors plus the caller, once each, in order (the config row lock serializes writers). */
const withCaller = (ctx: Ctx, v: VersionRow): string[] => (v.contributorIds.includes(ctx.user.id) ? v.contributorIds : [...v.contributorIds, ctx.user.id]);

/** One page of the space's recons, name A–Z unless `sort` says otherwise. */
export function reconPage(ctx: Ctx, q: ReconListQuery): Promise<Page<ReconRowDto>> {
  return inSpace(ctx, async (tx, spaceId) => {
    const like = q.q?.trim() ? `%${likeEscape(q.q.trim())}%` : null;
    const where = and(eq(reconConfigs.spaceId, spaceId), like ? or(ilike(reconConfigs.code, like), ilike(reconConfigs.name, like)) : undefined);
    // at most one published version per config (recon_config_versions_published_key)
    const published = and(eq(reconConfigVersions.spaceId, reconConfigs.spaceId), eq(reconConfigVersions.configId, reconConfigs.id), eq(reconConfigVersions.status, "published"));
    return pageQuery({
      rows: tx.select({ c: reconConfigs, published: reconConfigVersions.version }).from(reconConfigs).leftJoin(reconConfigVersions, published).where(where).$dynamic(),
      count: tx.select(one).from(reconConfigs).where(where).$dynamic(),
      orderBy: sortSql(q.sort, { name: sql`lower(${reconConfigs.name})`, createdAt: reconConfigs.createdAt }, "name", reconConfigs.id),
      query: q,
      map: (r) => rowDto(r.c, r.published),
      on: tx,
    });
  });
}

/** GET …/recons/:configId. */
export function reconDetail(ctx: Ctx, id: string): Promise<ReconDto> {
  return inSpace(ctx, async (tx, spaceId) => detailDto(tx, await configOf(tx, spaceId, id)));
}

/**
 * The first save (Plan 3 README row): the config and its draft version 1 with the spec, in one transaction, one
 * `recon.create` entry. 409 `duplicate` for a code the space already has (any case), 400 for a spec its sides refuse;
 * nothing is made either way.
 */
export function createRecon(ctx: Ctx, b: CreateReconBody): Promise<ReconDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    await checked(tx, spaceId, b.spec);
    let c: ConfigRow;
    try {
      [c] = await tx.insert(reconConfigs).values({ id: Bun.randomUUIDv7(), spaceId, code: b.code, name: b.name }).returning() as [ConfigRow];
    } catch (e) {
      // the only unique key a new id can hit is (space_id, code)
      throw isUniqueViolation(e) ? new ApiError("duplicate", "Another recon in this space already has this code. Use a different one.") : e;
    }
    const hash = specHash(b.spec);
    await tx.insert(reconConfigVersions).values({
      id: Bun.randomUUIDv7(), configId: c.id, spaceId, version: 1, status: "draft", spec: b.spec, specHash: hash, makerId: ctx.user.id, contributorIds: [ctx.user.id],
    });
    await recordActivity(tx, ctx, { action: "recon.create", target: target(c), after: { code: c.code, name: c.name, version: 1, specHash: hash } });
    return detailDto(tx, c);
  });
}

/** POST …/versions: a new draft (version = last + 1) holding the published spec. 409 `duplicate` while a draft or a version in review exists. */
export function createDraft(ctx: Ctx, id: string): Promise<ReconVersionDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const c = await configOf(tx, spaceId, id, true);
    const live = await tx.select().from(reconConfigVersions).where(and(ofConfig(c), inArray(reconConfigVersions.status, ["draft", "in_review", "published"])));
    const from = live.find((v) => v.status === "published");
    if (!from || live.some((v) => v.status !== "published")) throw new ApiError("duplicate", "This recon already has a draft or a version in review. Finish that one first.");
    const [last] = await tx.select({ n: max(reconConfigVersions.version) }).from(reconConfigVersions).where(ofConfig(c));
    const [v] = await tx.insert(reconConfigVersions).values({
      id: Bun.randomUUIDv7(), configId: c.id, spaceId, version: (last?.n ?? 0) + 1, status: "draft", spec: from.spec, specHash: from.specHash,
      makerId: ctx.user.id, contributorIds: [ctx.user.id],
    }).returning() as [VersionRow];
    await recordActivity(tx, ctx, { action: "recon.version_create", target: target(c), after: { version: v.version, from: from.version } });
    return withWarnings(tx, spaceId, v);
  });
}

/**
 * Saves a draft's whole spec; the caller becomes its maker and a contributor. A spec its sides refuse is 400; the same
 * spec again is the version as it is, no entry. The answer carries the warnings (carry over, tolerance).
 */
export function updateVersion(ctx: Ctx, id: string, versionId: string, b: UpdateReconVersionBody): Promise<ReconVersionDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const c = await configOf(tx, spaceId, id, true);
    const v = await versionOf(tx, c, versionId);
    if (!canStep("edit", v.status as VersionStatus)) throw wrongState("Only a draft can be edited. Make a new draft from the published version.");
    const { warnings } = await checked(tx, spaceId, b.spec);
    const hash = specHash(b.spec);
    if (hash === v.specHash) return versionDto(v, warnings);
    const [row] = await tx.update(reconConfigVersions).set({ spec: b.spec, specHash: hash, makerId: ctx.user.id, contributorIds: withCaller(ctx, v), updatedAt: NOW })
      .where(eq(reconConfigVersions.id, v.id)).returning() as [VersionRow];
    await recordActivity(tx, ctx, { action: "recon.version_update", target: target(c), before: { version: v.version, specHash: v.specHash }, after: { version: v.version, specHash: hash } });
    return versionDto(row, warnings);
  });
}

/**
 * Sends a draft to review: it has a pass, its check has no error and no gate (carry over), and its last simulation ran
 * on the spec as it is now (simulated_hash = spec_hash, written by the simulation, Plan 3 Task 3). The caller becomes
 * a contributor and its submitter.
 */
export function submitVersion(ctx: Ctx, id: string, versionId: string): Promise<ReconVersionDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const c = await configOf(tx, spaceId, id, true);
    const v = await versionOf(tx, c, versionId);
    if (!canStep("submit", v.status as VersionStatus)) throw wrongState("Only a draft can be submitted.");
    const spec = v.spec as ReconSpec;
    if (!spec.passes.length) throw new ApiError("bad_request", "Add at least one pass, then submit.");
    const { gates, warnings } = await checked(tx, spaceId, spec);
    if (gates[0]) throw new ApiError("bad_request", gates[0]);
    if (v.simulatedHash === null) throw new ApiError("bad_request", "Run a simulation on this draft first.");
    if (v.simulatedHash !== v.specHash) throw new ApiError("bad_request", "The draft changed after the last simulation. Run it again.");
    const [row] = await tx.update(reconConfigVersions).set({ status: "in_review", contributorIds: withCaller(ctx, v), submittedBy: ctx.user.id, submittedAt: NOW, updatedAt: NOW })
      .where(eq(reconConfigVersions.id, v.id)).returning() as [VersionRow];
    await recordActivity(tx, ctx, { action: "recon.version_submit", target: target(c), after: { version: v.version, specHash: v.specHash } });
    return versionDto(row, warnings);
  });
}

/** 409 `self_approval` when the caller created, edited or submitted the version (spec §11: maker ≠ checker by user id). */
function notAContributor(ctx: Ctx, v: VersionRow): void {
  if (v.makerId === ctx.user.id || v.contributorIds.includes(ctx.user.id)) throw new ApiError("self_approval");
}

/**
 * Publishes a version in review (its check again: a source may have changed since the submit); the published one
 * before it retires. The fields it reads from each side's source are written to recon_source_uses (A4) under each
 * source's fields lock, in id order, so a source version checked at the same time sees them.
 */
export function approveVersion(ctx: Ctx, id: string, versionId: string): Promise<ReconVersionDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const c = await configOf(tx, spaceId, id, true);
    const v = await versionOf(tx, c, versionId);
    notAContributor(ctx, v);
    if (!canStep("approve", v.status as VersionStatus)) throw wrongState("Only a version in review can be approved.");
    const spec = v.spec as ReconSpec;
    for (const sourceId of [...new Set(spec.sides.map((s) => s.source_id))].sort()) await sourceFieldsLock(tx, sourceId);
    const { warnings, owners } = await checked(tx, spaceId, spec);
    const [retired] = await tx.update(reconConfigVersions).set({ status: "retired", updatedAt: NOW })
      .where(and(ofConfig(c), eq(reconConfigVersions.status, "published"))).returning({ version: reconConfigVersions.version });
    const [row] = await tx.update(reconConfigVersions).set({ status: "published", checkerId: ctx.user.id, publishedAt: NOW, reviewComment: null, updatedAt: NOW })
      .where(eq(reconConfigVersions.id, v.id)).returning() as [VersionRow];
    await tx.delete(reconSourceUses).where(and(eq(reconSourceUses.spaceId, spaceId), eq(reconSourceUses.configId, c.id)));
    const uses = new Map<string, typeof reconSourceUses.$inferInsert>();
    usedFields(spec).forEach((fields, i) => {
      const sourceId = spec.sides[i]!.source_id;
      for (const field of fields) uses.set(`${sourceId} ${field}`, { spaceId, configId: c.id, sourceSpaceId: owners[i]!, sourceId, field, configName: c.name });
    });
    if (uses.size) await tx.insert(reconSourceUses).values([...uses.values()]);
    await recordActivity(tx, ctx, { action: "recon.version_approve", target: target(c), after: { version: v.version, specHash: v.specHash, retired: retired?.version ?? null } });
    return versionDto(row, warnings);
  });
}

/** Sends a version in review back to draft with the checker's comment; `checkerId` = who sent it back. */
export function rejectVersion(ctx: Ctx, id: string, versionId: string, b: RejectReconVersionBody): Promise<ReconVersionDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const c = await configOf(tx, spaceId, id, true);
    const v = await versionOf(tx, c, versionId);
    notAContributor(ctx, v);
    if (!canStep("reject", v.status as VersionStatus)) throw wrongState("Only a version in review can be rejected.");
    const [row] = await tx.update(reconConfigVersions).set({ status: "draft", reviewComment: b.comment, checkerId: ctx.user.id, updatedAt: NOW })
      .where(eq(reconConfigVersions.id, v.id)).returning() as [VersionRow];
    await recordActivity(tx, ctx, { action: "recon.version_reject", target: target(c), after: { version: v.version, comment: b.comment } });
    return withWarnings(tx, spaceId, row);
  });
}

/**
 * DELETE …/recons/:configId ("Delete draft recon", README row Plan 3): a recon nobody ever submitted (no version in
 * review, published, retired or sent back), with its draft (cascade); `recon.discard` in the same transaction.
 * Anything else is 409 invalid_state: a recon with a history stays.
 */
export function discardRecon(ctx: Ctx, id: string): Promise<void> {
  return inSpace(ctx, async (tx, spaceId) => {
    const c = await configOf(tx, spaceId, id, true);
    const vs = await tx.select({ status: reconConfigVersions.status, submittedAt: reconConfigVersions.submittedAt }).from(reconConfigVersions).where(ofConfig(c));
    if (vs.some((v) => v.status !== "draft" || v.submittedAt !== null)) {
      throw wrongState("Only a recon that was never submitted for approval can be deleted. Its history stays.");
    }
    await tx.delete(reconConfigs).where(and(eq(reconConfigs.spaceId, spaceId), eq(reconConfigs.id, id)));
    await recordActivity(tx, ctx, { action: "recon.discard", target: target(c), before: { code: c.code, name: c.name } });
  });
}

/** The names of `ids` (one query); a deleted user has none. */
async function namesOf(tx: InTx, ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return new Map();
  return new Map((await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, wanted))).map((u) => [u.id, u.name]));
}
const person = (names: Map<string, string>, id: string | null) => (id ? { id, name: names.get(id) ?? null } : null);

/** GET …/versions: one page of the config's versions, newest first unless `sort` says otherwise. */
export function versionPage(ctx: Ctx, id: string, q: ReconVersionListQuery): Promise<Page<ReconVersionRowDto>> {
  return inSpace(ctx, async (tx, spaceId) => {
    const c = await configOf(tx, spaceId, id);
    const page = await pageQuery({
      rows: tx.select().from(reconConfigVersions).where(ofConfig(c)).$dynamic(),
      count: tx.select(one).from(reconConfigVersions).where(ofConfig(c)).$dynamic(),
      orderBy: sortSql(q.sort, { version: reconConfigVersions.version, updatedAt: reconConfigVersions.updatedAt }, "-version", reconConfigVersions.id),
      query: q,
      map: (r) => r,
      on: tx,
    });
    const names = await namesOf(tx, page.items.flatMap((v) => [v.makerId, v.submittedBy, v.checkerId]));
    return {
      ...page,
      items: page.items.map((v): ReconVersionRowDto => ({
        id: v.id, version: v.version, status: v.status as VersionStatus, maker: person(names, v.makerId), submitter: person(names, v.submittedBy),
        checker: person(names, v.checkerId), reviewComment: v.reviewComment, submittedAt: iso(v.submittedAt), publishedAt: iso(v.publishedAt),
        createdAt: v.createdAt.toISOString(), updatedAt: v.updatedAt.toISOString(),
      })),
    };
  });
}

/** GET …/versions/:versionId: the version with the names of everyone it names. */
export function versionDetail(ctx: Ctx, id: string, versionId: string): Promise<ReconVersionDetailDto> {
  return inSpace(ctx, async (tx, spaceId) => {
    const v = await versionOf(tx, await configOf(tx, spaceId, id), versionId);
    const ids = [...new Set([v.makerId, ...v.contributorIds, v.submittedBy, v.checkerId].filter((x): x is string => !!x))];
    const names = await namesOf(tx, ids);
    return { ...(await withWarnings(tx, spaceId, v)), people: ids.map((x) => person(names, x)!) };
  });
}

/** GET …/activity: the recon's own trail, newest first, for any member of its space (read through the audit module). */
export async function reconActivity(ctx: Ctx, id: string, q: ReconActivityQuery): Promise<Page<ActivityDto>> {
  const c = await inSpace(ctx, (tx, spaceId) => configOf(tx, spaceId, id));
  return targetActivityPage({ type: "recon", id: c.id }, q);
}

/**
 * For the sources module (Plan 3 A4): which published recons read each of `fields` from source `sourceId`, by name,
 * in any space the caller's transaction sees through the source owner's read policy (drizzle/0021). Field → names A–Z.
 */
export async function reconsUsingFields(tx: InTx, sourceId: string, fields: string[]): Promise<Map<string, string[]>> {
  if (!fields.length) return new Map();
  const rows = await tx.select({ field: reconSourceUses.field, name: reconSourceUses.configName }).from(reconSourceUses)
    .where(and(eq(reconSourceUses.sourceId, sourceId), inArray(reconSourceUses.field, fields)));
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.field, [...(out.get(r.field) ?? []), r.name].sort());
  return out;
}
