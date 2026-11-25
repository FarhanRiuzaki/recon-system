import type { FacetsDto, Page } from "@starterkit/shared/contracts/common";
import type { ApprovalListQuery, ApprovalRowDto } from "@starterkit/shared/contracts/approvals";
import { type ApprovalKind, approvalBlocked, isRequestKind } from "@starterkit/shared/approvals";
import { isSuperadmin } from "@starterkit/shared/permissions";
import { and, eq, ilike, inArray, or, type SQL, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { countN, facetOf, likeEscape, one, pageQuery, sortSql } from "../../kernel/pagination";
import type { Ctx } from "../auth";
import { reconConfigs, reconConfigVersions } from "../recon";
import { sources, sourceVersions } from "../sources";
import { reportTemplates, reportVersions } from "../reports";
import type { InTx } from "../../kernel/db";
import { withSpace } from "../spaces";
import { itemsOf } from "../engine";
import { decidable } from "./requests";
import { approvalRequests } from "./schema";
import { users } from "../users";

/** Pending break requests "Waiting for me" checks at most, oldest first; past it the page says `totalCapped`. */
export const INBOX_REQUESTS_MAX = 500;

/**
 * GET …/approvals: the space's source and recon versions in review, waiting longest first unless `sort` says otherwise;
 * each says whether the caller may decide it (approvalBlocked). One union, paged in the database.
 */
/** The inbox as one union subquery `u` (source versions, recon versions, break requests), filtered by `q`. */
async function inbox(tx: InTx, ctx: Ctx, q: Omit<ApprovalListQuery, "page" | "pageSize" | "sort">) {
    const spaceId = ctx.space!.id;
    const kinds: readonly string[] = q.kind ?? [];
    const reqKinds = kinds.filter(isRequestKind);
    const like = q.q?.trim() ? `%${likeEscape(q.q.trim())}%` : null;
    const checker = ctx.space!.roles.includes("config_checker");
    const superadmin = isSuperadmin(ctx.user.roles);
    const me = ctx.user.id;
    // mine: what approvalBlocked lets the caller decide, as SQL (not its maker, not among its contributors); nothing
    // for someone who isn't a config checker of the space
    const mine = <T extends typeof sourceVersions | typeof reconConfigVersions | typeof reportVersions>(v: T) =>
      !q.mine || superadmin ? undefined : checker ? and(sql`${v.makerId} is distinct from ${me}`, sql`not (${me}::uuid = any(${v.contributorIds}))`) : sql`false`;
    const src = tx.select({
      kind: sql<ApprovalKind>`'source_version'`.as("kind"), id: sourceVersions.id, targetId: sql<string>`${sources.id}`.as("target_id"), code: sources.code, name: sources.name,
      version: sourceVersions.version, makerId: sourceVersions.makerId, contributorIds: sourceVersions.contributorIds,
      submittedBy: sourceVersions.submittedBy, submittedAt: sourceVersions.submittedAt,
    }).from(sourceVersions).innerJoin(sources, and(eq(sources.spaceId, sourceVersions.spaceId), eq(sources.id, sourceVersions.sourceId)))
      .where(and(eq(sourceVersions.spaceId, spaceId), eq(sourceVersions.status, "in_review"), mine(sourceVersions), like ? or(ilike(sources.name, like), ilike(sources.code, like)) : undefined));
    const rec = tx.select({
      kind: sql<ApprovalKind>`'recon_version'`.as("kind"), id: reconConfigVersions.id, targetId: sql<string>`${reconConfigs.id}`.as("target_id"), code: reconConfigs.code, name: reconConfigs.name,
      version: reconConfigVersions.version, makerId: reconConfigVersions.makerId, contributorIds: reconConfigVersions.contributorIds,
      submittedBy: reconConfigVersions.submittedBy, submittedAt: reconConfigVersions.submittedAt,
    }).from(reconConfigVersions).innerJoin(reconConfigs, and(eq(reconConfigs.spaceId, reconConfigVersions.spaceId), eq(reconConfigs.id, reconConfigVersions.configId)))
      .where(and(eq(reconConfigVersions.spaceId, spaceId), eq(reconConfigVersions.status, "in_review"), mine(reconConfigVersions), like ? or(ilike(reconConfigs.name, like), ilike(reconConfigs.code, like)) : undefined));
    // an official report template version (DEC-060): one config checker who had no hand in it, as a source version
    const rep = tx.select({
      kind: sql<ApprovalKind>`'report_version'`.as("kind"), id: reportVersions.id, targetId: sql<string>`${reportTemplates.id}`.as("target_id"),
      code: sql<string>`${reportTemplates.name}`.as("code"), name: reportTemplates.name,
      version: reportVersions.version, makerId: reportVersions.makerId, contributorIds: reportVersions.contributorIds,
      submittedBy: reportVersions.submittedBy, submittedAt: reportVersions.submittedAt,
    }).from(reportVersions).innerJoin(reportTemplates, and(eq(reportTemplates.spaceId, reportVersions.spaceId), eq(reportTemplates.id, reportVersions.templateId)))
      .where(and(eq(reportVersions.spaceId, spaceId), eq(reportVersions.status, "waiting"), mine(reportVersions), like ? ilike(reportTemplates.name, like) : undefined));
    // a break's request (DEC-052): who may decide it follows its chain's current level, so "mine" is read request by
    // request in code, over the INBOX_REQUESTS_MAX oldest pending ones (`capped` when there are more).
    // ponytail: a space with more than that waiting needs the level check in SQL
    const lead = superadmin || ctx.space!.roles.some((r) => r === "space_admin" || r === "reviewer");
    let reqMine: SQL | undefined;
    let capped = false;
    if (q.mine) {
      const read = await tx.select().from(approvalRequests).where(and(eq(approvalRequests.spaceId, spaceId), eq(approvalRequests.status, "pending")))
        .orderBy(approvalRequests.requestedAt, approvalRequests.id).limit(INBOX_REQUESTS_MAX + 1);
      capped = read.length > INBOX_REQUESTS_MAX;
      const pending = read.slice(0, INBOX_REQUESTS_MAX);
      const ok = [...(await decidable(tx, ctx, pending))].filter(([, why]) => why === null).map(([id]) => id);
      reqMine = ok.length ? inArray(approvalRequests.id, ok) : sql`false`;
    }
    const req = tx.select({
      kind: sql<ApprovalKind>`${approvalRequests.kind}`.as("kind"), id: approvalRequests.id, targetId: sql<string>`${approvalRequests.itemId}`.as("target_id"),
      code: sql<string>`${approvalRequests.label}`.as("code"), name: reconConfigs.name, version: sql<number>`null::int`.as("version"),
      makerId: sql<string | null>`${approvalRequests.requestedBy}`.as("maker_id"), contributorIds: sql<string[]>`'{}'::uuid[]`.as("contributor_ids"),
      submittedBy: sql<string | null>`${approvalRequests.requestedBy}`.as("submitted_by"), submittedAt: sql<Date | null>`${approvalRequests.requestedAt}`.as("submitted_at"),
    }).from(approvalRequests).innerJoin(reconConfigs, and(eq(reconConfigs.spaceId, approvalRequests.spaceId), eq(reconConfigs.id, approvalRequests.configId)))
      .where(and(eq(approvalRequests.spaceId, spaceId), eq(approvalRequests.status, "pending"), reqKinds.length ? inArray(approvalRequests.kind, reqKinds) : undefined, reqMine,
        like ? or(ilike(reconConfigs.name, like), ilike(approvalRequests.label, like)) : undefined));
    const arms = [!kinds.length || kinds.includes("source_version") ? src : null, !kinds.length || kinds.includes("recon_version") ? rec : null, !kinds.length || kinds.includes("report_version") ? rep : null, !kinds.length || reqKinds.length ? req : null]
      // one row shape for all four (the union needs it; drizzle types each arm by its own table)
      .filter((a) => !!a) as unknown as (typeof src)[];
    const [first, second, ...rest] = arms;
    const u = (second ? unionAll(first!, second, ...rest) : first!).as("u");
    return { u, me, checker, lead, superadmin, capped };
}

/** GET …/approvals/facets: what waits per kind, with the other filters (search, mine) applied. */
export function approvalFacets(ctx: Ctx, q: ApprovalListQuery): Promise<FacetsDto> {
  return withSpace({ spaceIds: [ctx.space!.id], userId: ctx.user.id }, async (tx) => {
    const { u } = await inbox(tx, ctx, { ...q, kind: undefined });
    return { kind: facetOf(await tx.select({ v: u.kind, n: countN }).from(u).groupBy(u.kind)) };
  });
}

/**
 * The inbox's "Waiting for me" total (approvalPage with `mine`) up to `cap` + 1, under the caller's withSpace;
 * `capped` as the page's `totalCapped` (more pending break requests than the inbox checks).
 */
export async function waitingCount(tx: InTx, ctx: Ctx, cap: number): Promise<{ n: number; capped: boolean }> {
  const { u, capped } = await inbox(tx, ctx, { mine: "1" });
  return { n: (await tx.select({ n: countN }).from(tx.select(one).from(u).limit(cap + 1).as("w")))[0]!.n, capped };
}

export function approvalPage(ctx: Ctx, q: ApprovalListQuery): Promise<Page<ApprovalRowDto>> {
  const spaceId = ctx.space!.id;
  return withSpace({ spaceIds: [spaceId], userId: ctx.user.id }, async (tx) => {
    const { u, me, checker, superadmin, capped } = await inbox(tx, ctx, q);
    const page = await pageQuery({
      rows: tx.select().from(u).$dynamic(),
      count: tx.select(one).from(u).$dynamic(),
      orderBy: sortSql(q.sort, { submittedAt: sql`${u.submittedAt}`, name: sql`lower(${u.name})` }, "submittedAt", u.id),
      query: q,
      map: (r) => r,
      on: tx,
    });
    const ids = [...new Set(page.items.map((r) => r.submittedBy).filter((x): x is string => !!x))];
    const names = new Map(ids.length ? (await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map((x) => [x.id, x.name]) : []);
    // a break request's level and whether the caller decides it now, from its chain
    const reqIds = page.items.filter((r) => isRequestKind(r.kind)).map((r) => r.id);
    const reqs = reqIds.length ? await tx.select().from(approvalRequests).where(inArray(approvalRequests.id, reqIds)) : [];
    const why = await decidable(tx, ctx, reqs);
    const levelOf = new Map(reqs.map((r) => [r.id, { at: r.currentLevel + 1, of: (r.chain as unknown[]).length }]));
    const reqOf = new Map(reqs.map((r) => [r.id, r]));
    // the break's amount as written; a force match's gap is the rule attribute it was asked with
    const items = new Map((await itemsOf(tx, spaceId, reqs.map((r) => r.itemId))).map((i) => [i.id, i]));
    const amountOf = (id: string) => {
      const i = items.get(reqOf.get(id)?.itemId ?? "");
      return i?.amountMinor ? { minor: i.amountMinor, currency: i.currency } : null;
    };
    const differenceOf = (id: string) => {
      const r = reqOf.get(id);
      const at = r?.attributes as { amount?: string; currency?: string | null } | undefined;
      return r?.kind === "force_match" && at?.amount ? { minor: at.amount, currency: at.currency ?? null } : null;
    };
    return {
      ...page,
      ...(capped ? { totalCapped: true } : {}),
      items: page.items.map((r) => ({
        kind: r.kind, id: r.id, target: { id: r.targetId, code: r.code, name: r.name }, version: r.version,
        submitter: r.submittedBy ? { id: r.submittedBy, name: names.get(r.submittedBy) ?? null } : null,
        submittedAt: r.submittedAt ? new Date(r.submittedAt).toISOString() : null,
        blocked: isRequestKind(r.kind) ? why.get(r.id) ?? null : approvalBlocked(r.kind, r, me, checker, superadmin),
        level: levelOf.get(r.id) ?? null,
        amount: amountOf(r.id), difference: differenceOf(r.id), workflowName: reqOf.get(r.id)?.workflowName ?? null,
      })),
    };
  });
}
