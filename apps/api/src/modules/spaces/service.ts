// Spaces: the space scope of a transaction (row level security) and a user's roles in a space.
import { SPACE_ROLES, type SpaceRole } from "@starterkit/shared/spaces";
import { and, eq, sql } from "drizzle-orm";
import { db, type InTx, type Tx } from "../../kernel/db";
import { isUuid } from "../../kernel/parse";
import { spaceMembers } from "./schema";

/**
 * Runs `fn` in a transaction that sees only rows of `spaceIds` in tables whose policy is `recon_space_visible(space_id)`
 * (drizzle/0007_space_rls.sql). The settings are transaction-local: once it ends, the pooled connection is back to ''
 * and sees nothing. Ids must be UUIDs: they travel comma-joined, so a comma in one would add a space.
 */
export function withSpace<T>(scope: { spaceIds: string[]; userId: string }, fn: (tx: InTx) => Promise<T>): Promise<T> {
  if (!scope.spaceIds.every(isUuid) || !isUuid(scope.userId)) return Promise.reject(new Error("withSpace: space and user ids must be UUIDs"));
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.space_ids', ${scope.spaceIds.join(",")}, true), set_config('app.user_id', ${scope.userId}, true)`);
    return fn(tx);
  });
}

/** The roles `userId` holds in `spaceId`, in SPACE_ROLES order, share-locked until `tx` ends; [] = not a member. */
export async function spaceRolesOf(tx: Tx, userId: string, spaceId: string): Promise<SpaceRole[]> {
  const rows = await tx.select({ role: spaceMembers.role }).from(spaceMembers)
    .where(and(eq(spaceMembers.spaceId, spaceId), eq(spaceMembers.userId, userId))).for("share");
  return SPACE_ROLES.filter((r) => rows.some((x) => x.role === r));
}
