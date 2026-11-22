import { eq, sql } from "drizzle-orm";
import type { Tx } from "../../kernel/db";
import { type SpaceRole, spaceMembers, spaces } from "../../modules/spaces";
import { users } from "../../modules/users";
import { DEFAULT_PEOPLE } from "./users";

/** The roles the first Superadmin gets in the local space: enough to create sources and configs through the wizard. */
export const LOCAL_ROLES: readonly SpaceRole[] = ["space_admin", "source_admin", "config_maker"];
/** The default maker's and approver's roles in Treasury: the maker sets up sources and recons, the approver checks them. */
export const PEOPLE_ROLES: Record<(typeof DEFAULT_PEOPLE)[number]["username"], readonly SpaceRole[]> = {
  // maker also works breaks and asks for their changes; approver also decides them (the default approval chain, DEC-052)
  maker: ["source_admin", "config_maker", "operator"],
  approver: ["config_checker", "reviewer"],
};

/**
 * A minimal local stack (docker compose, `bun src/db/seed/cli.ts local`): one space, Treasury, with the user named by
 * LOCAL_ADMIN_USERNAME (else SEED_SUPERADMIN_USERNAME) as space admin, source admin and config maker. No sources: they
 * are made through the wizard. The default maker and approver (the user seeder, when their password keys are set) get
 * their roles in Treasury (PEOPLE_ROLES), so a version made by one is approved by the other. Idempotent: a second run
 * finds the space, the users and the memberships and adds no row twice.
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
    for (const p of DEFAULT_PEOPLE) {
      const [person] = await tx.select({ id: users.id }).from(users).where(sql`lower(${users.username}) = ${p.username}`).limit(1);
      if (person) await tx.insert(spaceMembers).values(PEOPLE_ROLES[p.username].map((role) => ({ spaceId: space!.id, userId: person.id, role }))).onConflictDoNothing();
    }
    return { spaceId: space!.id };
  });
}
