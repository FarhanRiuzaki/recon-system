// Spaces: the space scope of a transaction (row level security), a user's roles in a space, and the logic of
// /v1/spaces*: 404 → rules → change → activity entry, in one transaction per change.
import type { Page } from "@starterkit/shared/contracts/common";
import type {
  CreateSpaceBody, SetSpaceMemberBody, SpaceCandidateDto, SpaceCandidateListQuery, SpaceDto, SpaceListQuery, SpaceMemberDto, SpaceMemberListQuery,
  SpaceRowDto, SpaceStatus, UpdateSpaceBody, UserSpaceDto, UserSpaceListQuery,
} from "@starterkit/shared/contracts/spaces";
import { SPACE_ROLES, type SpaceRole } from "@starterkit/shared/spaces";
import { and, eq, exists, ilike, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { db, type InTx, type Tx } from "../../kernel/db";
import { ApiError, isUniqueViolation, notFound } from "../../kernel/errors";
import { xactLock } from "../../kernel/locks";
import { likeEscape, one, pageQuery, sortSql } from "../../kernel/pagination";
import { isUuid } from "../../kernel/parse";
import { recordActivity } from "../audit";
import { actorPermissions, type Ctx } from "../auth";
import { users } from "../users";
import { canManageMembers, sourceAdminChanged } from "./rules";
import { spaceMembers, spaces } from "./schema";

/**
 * Runs `fn` in a transaction on `on` that sees only rows of `spaceIds` in tables whose policy is
 * `recon_space_visible(space_id)` (drizzle/0007_space_rls.sql, 0008). `userId` null (a job) sets app.user_id to ''.
 * A job handler passes `workerDb` (kernel/worker-db.ts) as `on`; this module never imports it, so the API process
 * never opens the worker pool. The settings are transaction-local: once it ends, the pooled connection is back to ''
 * and sees nothing. Ids must be UUIDs: they travel comma-joined, so a comma in one would add a space.
 */
export function withSpace<T>(scope: { spaceIds: string[]; userId: string | null }, fn: (tx: InTx) => Promise<T>, on: Tx = db): Promise<T> {
  if (!scope.spaceIds.every(isUuid) || (scope.userId !== null && !isUuid(scope.userId))) {
    return Promise.reject(new Error("withSpace: space and user ids must be UUIDs"));
  }
  return on.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.space_ids', ${scope.spaceIds.join(",")}, true), set_config('app.user_id', ${scope.userId ?? ""}, true)`);
    return fn(tx);
  });
}

/** The roles `userId` holds in `spaceId`, in SPACE_ROLES order, share-locked until `tx` ends; [] = not a member. */
export async function spaceRolesOf(tx: Tx, userId: string, spaceId: string): Promise<SpaceRole[]> {
  const rows = await tx.select({ role: spaceMembers.role }).from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId))).for("share");
  return SPACE_ROLES.filter((r) => rows.some((x) => x.role === r));
}

const NOW = sql`now()`;
const DUPLICATE = () => new ApiError("duplicate", "Another space already has this code. Use a different one.");

type Row = typeof spaces.$inferSelect;
const dto = (r: Row): SpaceDto => ({
  id: r.id, code: r.code, name: r.name, status: r.status as SpaceStatus, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(),
});
/** Role names from the database in SPACE_ROLES order. */
const inOrder = (roles: readonly string[] | null): SpaceRole[] => SPACE_ROLES.filter((r) => roles?.includes(r));

/**
 * One page of spaces (GET /v1/spaces) with the caller's roles in each: the spaces they are a member of, or every space
 * with `space.view` (a space without a role still gives no access to its data). Name A–Z unless `sort` says otherwise.
 */
export function spacePage(ctx: Ctx, q: SpaceListQuery): Promise<Page<SpaceRowDto>> {
  const mine = db.select({ spaceId: spaceMembers.spaceId, roles: sql<string[]>`array_agg(${spaceMembers.role})`.as("roles") })
    .from(spaceMembers).where(eq(spaceMembers.userId, ctx.user.id)).groupBy(spaceMembers.spaceId).as("mine");
  const like = q.q?.trim() ? `%${likeEscape(q.q.trim())}%` : null;
  const where = and(
    like ? or(ilike(spaces.code, like), ilike(spaces.name, like)) : undefined,
    ctx.perms.has("space.view") ? undefined : isNotNull(mine.spaceId),
  );
  return pageQuery({
    rows: db.select({ s: spaces, roles: mine.roles }).from(spaces).leftJoin(mine, eq(mine.spaceId, spaces.id)).where(where).$dynamic(),
    count: db.select(one).from(spaces).leftJoin(mine, eq(mine.spaceId, spaces.id)).where(where).$dynamic(),
    orderBy: sortSql(q.sort, { name: sql`lower(${spaces.name})`, createdAt: spaces.createdAt }, "name", spaces.id),
    query: q,
    map: (r) => ({ ...dto(r.s), roles: inOrder(r.roles) }),
  });
}

/** New space without members; the code is unique ignoring letter case. */
export async function createSpace(ctx: Ctx, b: CreateSpaceBody): Promise<SpaceDto> {
  return db.transaction(async (tx) => {
    let row: Row;
    try {
      [row] = await tx.insert(spaces).values({ id: Bun.randomUUIDv7(), code: b.code, name: b.name }).returning() as [Row];
    } catch (e) {
      throw isUniqueViolation(e) ? DUPLICATE() : e; // the only unique key a new id can hit is lower(code)
    }
    const s = dto(row);
    await recordActivity(tx, ctx, { action: "space.create", target: { type: "space", id: s.id, label: s.name }, after: s });
    return s;
  });
}

/** Space `id`, row-locked when `forUpdate`; 404 when missing. */
async function spaceRow(tx: Tx, id: string, forUpdate = false): Promise<Row> {
  const q = tx.select().from(spaces).where(eq(spaces.id, id));
  const [r] = forUpdate ? await q.for("update") : await q;
  if (!r) throw notFound("space");
  return r;
}

/** Changes the fields sent; one `space.update` entry with the changed fields only. Nothing to change → the space, no entry. */
export async function updateSpace(ctx: Ctx, id: string, b: UpdateSpaceBody): Promise<SpaceDto> {
  return db.transaction(async (tx) => {
    const cur = dto(await spaceRow(tx, id, true));
    const keys = (["name", "status"] as const).filter((k) => b[k] !== undefined && b[k] !== cur[k]);
    if (!keys.length) return cur;
    const pick = (o: Pick<SpaceDto, "name" | "status">) => Object.fromEntries(keys.map((k) => [k, o[k]]));
    const after = pick({ name: b.name ?? cur.name, status: b.status ?? cur.status });
    const [row] = await tx.update(spaces).set({ ...after, updatedAt: NOW }).where(eq(spaces.id, id)).returning() as [Row];
    const s = dto(row);
    await recordActivity(tx, ctx, { action: "space.update", target: { type: "space", id, label: s.name }, before: pick(cur), after });
    return s;
  });
}

/** Space `id` with the caller's roles in it (GET /v1/spaces/:spaceId; [] when let in through `space.manage`); 404 when missing. */
export async function spaceDetail(id: string, roles: SpaceRole[]): Promise<SpaceRowDto> {
  return { ...dto(await spaceRow(db, id)), roles };
}

/** The member fields that come from the user's account, `lastSignInAt` = `last_login_at` (a function: `users` is another module's export). */
const memberUser = () => ({ userId: users.id, name: users.name, username: users.username, active: users.isActive, lastSignInAt: users.lastLoginAt });
const iso = (d: Date | null) => d?.toISOString() ?? null;

/** `q` (trimmed) as a name-or-username match. */
const nameOrUsername = (q: string | undefined) => {
  const like = q?.trim() ? `%${likeEscape(q.trim())}%` : null;
  return like ? or(ilike(users.name, like), ilike(users.username, like)) : undefined;
};

/** One page of a space's members (404 for no such space), each with every role they hold there; name A–Z. */
export async function memberPage(spaceId: string, q: SpaceMemberListQuery): Promise<Page<SpaceMemberDto>> {
  await spaceRow(db, spaceId);
  const where = and(eq(spaceMembers.spaceId, spaceId), nameOrUsername(q.q));
  return pageQuery({
    rows: db.select({ ...memberUser(), roles: sql<string[]>`array_agg(${spaceMembers.role})` })
      .from(spaceMembers).innerJoin(users, eq(users.id, spaceMembers.userId)).where(where).groupBy(users.id).$dynamic(),
    count: db.select(one).from(spaceMembers).innerJoin(users, eq(users.id, spaceMembers.userId)).where(where).groupBy(users.id).$dynamic(),
    orderBy: sortSql(q.sort, { name: sql`lower(${users.name})` }, "name", users.id),
    query: q,
    map: (r) => ({ ...r, roles: inOrder(r.roles), lastSignInAt: iso(r.lastSignInAt) }),
  });
}

/** One page of the app's users (404 for no such space), each marked `member` when they hold a role in the space; name A–Z. */
export async function candidatePage(spaceId: string, q: SpaceCandidateListQuery): Promise<Page<SpaceCandidateDto>> {
  await spaceRow(db, spaceId);
  const where = nameOrUsername(q.q);
  const member = exists(db.select(one).from(spaceMembers).where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, users.id))));
  return pageQuery({
    rows: db.select({ userId: users.id, name: users.name, username: users.username, active: users.isActive, member: sql<boolean>`${member}` })
      .from(users).where(where).$dynamic(),
    count: db.select(one).from(users).where(where).$dynamic(),
    orderBy: sortSql(q.sort, { name: sql`lower(${users.name})` }, "name", users.id),
    query: q,
    map: (r) => r,
  });
}

/** One page of the spaces `userId` is a member of (404 for no such user), each with every role they hold there; name A–Z. */
export async function userSpacePage(userId: string, q: UserSpaceListQuery): Promise<Page<UserSpaceDto>> {
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
  if (!user) throw notFound("user");
  const where = eq(spaceMembers.userId, userId);
  return pageQuery({
    rows: db.select({ spaceId: spaces.id, code: spaces.code, name: spaces.name, status: spaces.status, roles: sql<string[]>`array_agg(${spaceMembers.role})` })
      .from(spaceMembers).innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId)).where(where).groupBy(spaces.id).$dynamic(),
    count: db.select(one).from(spaceMembers).innerJoin(spaces, eq(spaces.id, spaceMembers.spaceId)).where(where).groupBy(spaces.id).$dynamic(),
    orderBy: sortSql(q.sort, { name: sql`lower(${spaces.name})` }, "name", spaces.id),
    query: q,
    map: (r) => ({ ...r, status: r.status as SpaceStatus, roles: inOrder(r.roles) }),
  });
}

/**
 * Takes the space-admin lock, then reads what the change depends on: the space (404), the user (404), the actor's
 * right to manage members (403, read now: the guard's read may be stale), whether the actor holds `space.manage` and
 * the user's current roles.
 */
async function memberChange(tx: Tx, ctx: Ctx, spaceId: string, userId: string) {
  await xactLock(tx, "spaceAdmins");
  const space = await spaceRow(tx, spaceId);
  const [user] = await tx.select(memberUser()).from(users).where(eq(users.id, userId));
  if (!user) throw notFound("user");
  const manage = (await actorPermissions(tx, ctx.user.id)).has("space.manage");
  if (!canManageMembers(await spaceRolesOf(tx, ctx.user.id, spaceId), manage)) throw new ApiError("forbidden");
  return { space, user, manage, roles: await spaceRolesOf(tx, userId, spaceId) };
}

const SOURCE_ADMIN_ONLY = () => new ApiError("forbidden", "Only an administrator with space.manage can grant or remove source_admin.");

/**
 * 409 when no other active user is a space_admin of the space (counted under the space-admin lock). Called for an active
 * target only: removing or demoting an inactive admin does not lower the active count.
 */
async function keepAnAdmin(tx: Tx, spaceId: string, userId: string): Promise<void> {
  const [other] = await tx.select(one).from(spaceMembers).innerJoin(users, eq(users.id, spaceMembers.userId))
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.role, "space_admin"), eq(users.isActive, true), ne(spaceMembers.userId, userId))).limit(1);
  if (!other) throw new ApiError("last_space_admin");
}

/**
 * 409 `last_space_admin` when deleting or deactivating every user of `userIds` would leave a space with no active
 * space_admin (users/service.ts: delete, deactivate, bulk). Takes the space-admin lock first; a caller that also locks
 * user rows takes this lock before them (a member change holds it while its foreign key check share-locks a user row).
 */
export async function assertNotLastSpaceAdmin(tx: Tx, userIds: string[]): Promise<void> {
  await xactLock(tx, "spaceAdmins");
  if (!userIds.length) return;
  const activeAdmin = and(eq(spaceMembers.role, "space_admin"), eq(users.isActive, true));
  // The spaces where one of them is an active admin, kept only when every active admin there is one of them.
  const [hit] = await tx.select({ spaceId: spaceMembers.spaceId }).from(spaceMembers).innerJoin(users, eq(users.id, spaceMembers.userId))
    .where(and(activeAdmin, inArray(spaceMembers.spaceId, tx.select({ id: spaceMembers.spaceId }).from(spaceMembers)
      .where(and(eq(spaceMembers.role, "space_admin"), inArray(spaceMembers.userId, userIds))))))
    .groupBy(spaceMembers.spaceId).having(sql`bool_and(${inArray(spaceMembers.userId, userIds)})`).limit(1);
  if (hit) throw new ApiError("last_space_admin", "This user is the only active space admin of a space. Make another member a space admin first.");
}

/**
 * Replaces the user's role set in the space; one `space.member_set` entry. The same set → no entry. Gaining or losing
 * source_admin needs `space.manage` (403 for a space_admin without it).
 */
export async function setMember(ctx: Ctx, spaceId: string, userId: string, b: SetSpaceMemberBody): Promise<SpaceMemberDto> {
  return db.transaction(async (tx) => {
    const { space, user, manage, roles: before } = await memberChange(tx, ctx, spaceId, userId);
    const roles = inOrder(b.roles);
    const member = { ...user, lastSignInAt: iso(user.lastSignInAt), roles };
    if (roles.join() === before.join()) return member;
    if (!manage && sourceAdminChanged(before, roles)) throw SOURCE_ADMIN_ONLY();
    if (user.active && before.includes("space_admin") && !roles.includes("space_admin")) await keepAnAdmin(tx, spaceId, userId);
    const of = and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId));
    await tx.delete(spaceMembers).where(of);
    await tx.insert(spaceMembers).values(roles.map((role) => ({ spaceId, userId, role })));
    const who = { id: userId, name: user.name };
    await recordActivity(tx, ctx, { action: "space.member_set", target: { type: "space", id: spaceId, label: space.name }, before: { user: who, roles: before }, after: { user: who, roles } });
    return member;
  });
}

/**
 * Removes the user from the space (404 when not a member); one `space.member_remove` entry. Removing a source_admin
 * needs `space.manage`.
 */
export async function removeMember(ctx: Ctx, spaceId: string, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const { space, user, manage, roles } = await memberChange(tx, ctx, spaceId, userId);
    if (!roles.length) throw notFound("member");
    if (!manage && roles.includes("source_admin")) throw SOURCE_ADMIN_ONLY();
    if (user.active && roles.includes("space_admin")) await keepAnAdmin(tx, spaceId, userId);
    await tx.delete(spaceMembers).where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId)));
    await recordActivity(tx, ctx, { action: "space.member_remove", target: { type: "space", id: spaceId, label: space.name }, before: { user: { id: userId, name: user.name }, roles } });
  });
}
