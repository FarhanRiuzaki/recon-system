import type { Page } from "@starterkit/shared/contracts/common";
import type { ApprovalListQuery, ApprovalRowDto } from "@starterkit/shared/contracts/approvals";
import { type ApprovalKind, approvalBlocked } from "@starterkit/shared/approvals";
import { and, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { likeEscape, one, pageQuery, sortSql } from "../../kernel/pagination";
import type { Ctx } from "../auth";
import { reconConfigs, reconConfigVersions } from "../recon";
import { sources, sourceVersions } from "../sources";
import { withSpace } from "../spaces";
import { users } from "../users";

/**
 * GET …/approvals: the space's source and recon versions in review, waiting longest first unless `sort` says otherwise;
 * each says whether the caller may decide it (approvalBlocked). One union, paged in the database.
 */
export function approvalPage(ctx: Ctx, q: ApprovalListQuery): Promise<Page<ApprovalRowDto>> {
  const spaceId = ctx.space!.id;
  return withSpace({ spaceIds: [spaceId], userId: ctx.user.id }, async (tx) => {
    const like = q.q?.trim() ? `%${likeEscape(q.q.trim())}%` : null;
    const checker = ctx.space!.roles.includes("config_checker");
    const me = ctx.user.id;
    // mine: what approvalBlocked lets the caller decide, as SQL (not its maker, not among its contributors); nothing
    // for someone who isn't a config checker of the space
    const mine = <T extends typeof sourceVersions | typeof reconConfigVersions>(v: T) =>
      !q.mine ? undefined : checker ? and(sql`${v.makerId} is distinct from ${me}`, sql`not (${me}::uuid = any(${v.contributorIds}))`) : sql`false`;
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
    const u = (q.kind === "source_version" ? src : q.kind === "recon_version" ? rec : unionAll(src, rec)).as("u");
    const page = await pageQuery({
      rows: tx.select().from(u).$dynamic(),
      count: tx.select(one).from(u).$dynamic(),
      orderBy: sortSql(q.sort, { submittedAt: u.submittedAt, name: sql`lower(${u.name})` }, "submittedAt", u.id),
      query: q,
      map: (r) => r,
      on: tx,
    });
    const ids = [...new Set(page.items.map((r) => r.submittedBy).filter((x): x is string => !!x))];
    const names = new Map(ids.length ? (await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map((x) => [x.id, x.name]) : []);
    return {
      ...page,
      items: page.items.map((r) => ({
        kind: r.kind, id: r.id, target: { id: r.targetId, code: r.code, name: r.name }, version: r.version,
        submitter: r.submittedBy ? { id: r.submittedBy, name: names.get(r.submittedBy) ?? null } : null,
        submittedAt: r.submittedAt ? new Date(r.submittedAt).toISOString() : null,
        blocked: approvalBlocked(r.kind, r, me, checker),
      })),
    };
  });
}
