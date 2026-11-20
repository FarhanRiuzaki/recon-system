import { eq, sql } from "drizzle-orm";
import type { Tx } from "../../kernel/db";
import { hashPassword } from "../../modules/auth";
import { roles, userRoles } from "../../modules/rbac";
import { type SpaceRole, spaceMembers, spaces } from "../../modules/spaces";
import { users } from "../../modules/users";

/** The roles the first Superadmin gets in the local space: enough to create sources and configs through the wizard. */
export const LOCAL_ROLES: readonly SpaceRole[] = ["space_admin", "source_admin", "config_maker"];
/** The local checker's space role: approves source versions and recon versions the admin made (maker ≠ checker). */
export const CHECKER_ROLES: readonly SpaceRole[] = ["config_checker"];
export const CHECKER_USERNAME = "checker";

/**
 * A minimal local stack (docker compose, `bun src/db/seed/cli.ts local`): one space, Treasury, with the user named by
 * LOCAL_ADMIN_USERNAME (else SEED_SUPERADMIN_USERNAME) as space admin, source admin and config maker. No sources: they
 * are made through the wizard. With LOCAL_CHECKER_PASSWORD set (the dev stack only, never production), also a user
 * `checker` (Viewer role, config checker in Treasury) so a version can be approved by someone other than its maker.
 * Idempotent: a second run finds the space, the user and the memberships and adds no row twice.
 */
export async function seedLocal(db: { transaction: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T> }, env: Record<string, string | undefined>) {
  const username = (env.LOCAL_ADMIN_USERNAME ?? env.SEED_SUPERADMIN_USERNAME)?.trim();
  if (!username) throw new Error("seed local needs LOCAL_ADMIN_USERNAME or SEED_SUPERADMIN_USERNAME (the user who becomes the space's admin).");
  const checkerPassword = env.LOCAL_CHECKER_PASSWORD;
  const checkerHash = checkerPassword ? await hashPassword(checkerPassword) : null;
  return db.transaction(async (tx) => {
    const [user] = await tx.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
    if (!user) throw new Error("seed local: the admin username names no user; run the system seed first.");
    await tx.insert(spaces).values({ id: Bun.randomUUIDv7(), code: "treasury", name: "Treasury" }).onConflictDoNothing();
    const [space] = await tx.select({ id: spaces.id }).from(spaces).where(sql`lower(${spaces.code}) = 'treasury'`).limit(1);
    await tx.insert(spaceMembers).values(LOCAL_ROLES.map((role) => ({ spaceId: space!.id, userId: user.id, role }))).onConflictDoNothing();
    if (checkerHash) {
      await tx.insert(users).values({ id: Bun.randomUUIDv7(), name: "Local Checker", username: CHECKER_USERNAME, email: "checker@recon.local", passwordHash: checkerHash }).onConflictDoNothing();
      const [checker] = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.username}) = ${CHECKER_USERNAME}`).limit(1);
      const [viewer] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.name, "Viewer")).limit(1);
      if (viewer) await tx.insert(userRoles).values({ userId: checker!.id, roleId: viewer.id }).onConflictDoNothing();
      await tx.insert(spaceMembers).values(CHECKER_ROLES.map((role) => ({ spaceId: space!.id, userId: checker!.id, role }))).onConflictDoNothing();
    }
    return { spaceId: space!.id };
  });
}
