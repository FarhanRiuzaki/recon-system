import { eq, sql } from "drizzle-orm";
import type { Tx } from "../../kernel/db";
import { type SpaceRole, spaceMembers, spaces } from "../../modules/spaces";
import { users } from "../../modules/users";

/** The roles the first Superadmin gets in the local space: enough to create sources and configs through the wizard. */
export const LOCAL_ROLES: readonly SpaceRole[] = ["space_admin", "source_admin", "config_maker"];

/**
 * A minimal local stack (docker compose, `bun src/db/seed/cli.ts local`): one space, Treasury, with the user named by
 * LOCAL_ADMIN_USERNAME (else SEED_SUPERADMIN_USERNAME) as space admin, source admin and config maker. No sources: they are made through the wizard.
 * Idempotent: a second run finds the space by its code and adds no row twice.
 */
export async function seedLocal(db: { transaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T> }, env: Record<string, string | undefined>) {
  const username = (env.LOCAL_ADMIN_USERNAME ?? env.SEED_SUPERADMIN_USERNAME)?.trim();
  if (!username) throw new Error("seed local needs LOCAL_ADMIN_USERNAME or SEED_SUPERADMIN_USERNAME (the user who becomes the space's admin).");
  return db.transaction(async (tx) => {
    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    if (!user) throw new Error("seed local: the admin username names no user; run the system seed first.");
    await tx.insert(spaces).values({ id: Bun.randomUUIDv7(), code: "treasury", name: "Treasury" }).onConflictDoNothing();
    const [space] = await tx.select({ id: spaces.id }).from(spaces).where(sql`lower(${spaces.code}) = 'treasury'`).limit(1);
    await tx.insert(spaceMembers).values(LOCAL_ROLES.map((role) => ({ spaceId: space!.id, userId: user.id, role }))).onConflictDoNothing();
    return { spaceId: space!.id };
  });
}
