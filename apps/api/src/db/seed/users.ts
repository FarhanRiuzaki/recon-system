import { and, eq, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { Password } from "@starterkit/shared/contracts/auth";
import { SUPERADMIN_ROLE } from "@starterkit/shared/permissions";
import type { InTx } from "../../kernel/db";
import { log } from "../../kernel/log";
import { hashPassword } from "../../modules/auth";
import { roles, userRoles } from "../../modules/rbac";
import { users } from "../../modules/users";

const OWNER_KEYS = ["SEED_SUPERADMIN_NAME", "SEED_SUPERADMIN_EMAIL", "SEED_SUPERADMIN_USERNAME", "SEED_SUPERADMIN_PASSWORD"] as const;

/** The superadmin to create from env: null when no key is set; every key set or an error naming the missing ones. */
function ownerOf(env: Record<string, string | undefined>) {
  const [name, email, username, password] = OWNER_KEYS.map((k) => env[k] || "");
  if (!name && !email && !username && !password) return null;
  const missing = OWNER_KEYS.filter((k) => !env[k]);
  if (missing.length) throw new Error(`Set every SEED_SUPERADMIN_* key or none; missing: ${missing.join(", ")}.`);
  if (!Password.safeParse(password).success) {
    if (env.NODE_ENV === "production") throw new Error("SEED_SUPERADMIN_PASSWORD must be 12 to 128 characters in production.");
    log.warn("SEED_SUPERADMIN_PASSWORD is outside 12 to 128 characters; accepted because NODE_ENV is not production.");
  }
  return { name: name!, email: email!, username: username!, password: password! };
}

/**
 * The default maker and approver (owner, 22 Nov: one default user each beside the superadmin), each made only when its
 * password key is set: SEED_MAKER_PASSWORD → `maker` (role Maker), SEED_APPROVER_PASSWORD → `approver` (role Approver).
 * In production the password must pass the password rule (12–128 characters).
 */
export const DEFAULT_PEOPLE = [
  { username: "maker", name: "Default Maker", email: "maker@recon.local", role: "Maker", key: "SEED_MAKER_PASSWORD" },
  { username: "approver", name: "Default Approver", email: "approver@recon.local", role: "Approver", key: "SEED_APPROVER_PASSWORD" },
] as const;

/** Each default person's password from env, checked as the superadmin's is; null when its key is unset. */
function peopleOf(env: Record<string, string | undefined>) {
  return DEFAULT_PEOPLE.flatMap((p) => {
    const password = env[p.key];
    if (!password) return [];
    if (!Password.safeParse(password).success) {
      if (env.NODE_ENV === "production") throw new Error(`${p.key} must be 12 to 128 characters in production.`);
      log.warn(`${p.key} is outside 12 to 128 characters; accepted because NODE_ENV is not production.`);
    }
    return [{ ...p, password }];
  });
}

/**
 * User seeder (after seedRoles), idempotent:
 * - the first Superadmin from SEED_SUPERADMIN_* when set. Bootstrap only: while any active user holds Superadmin the
 *   keys are skipped (one info line); a user with that email already there is left as it is; another user holding that
 *   username is an error.
 * - the default maker and approver (DEFAULT_PEOPLE) whose password key is set: a username already there is left as it
 *   is (its password and roles too), so a second run changes nothing.
 * Passwords are read from env only and stored as hashes; nothing is logged but the step.
 */
export async function seedUsers(tx: InTx, env: Record<string, string | undefined>): Promise<void> {
  const owner = ownerOf(env);
  const people = peopleOf(env);
  const roleId = async (name: string) => (await tx.select({ id: roles.id }).from(roles).where(eq(roles.name, name)))[0]!.id;
  const taken = (column: AnyPgColumn, value: string) =>
    tx.select({ id: users.id }).from(users).where(eq(sql`lower(${column})`, sql`lower(${value})`)).limit(1);
  await bootstrapSuperadmin(tx, owner, taken, roleId);
  for (const p of people) {
    if ((await taken(users.username, p.username)).length || (await taken(users.email, p.email)).length) continue;
    const id = Bun.randomUUIDv7();
    await tx.insert(users).values({ id, name: p.name, username: p.username, email: p.email, passwordHash: await hashPassword(p.password) });
    await tx.insert(userRoles).values({ userId: id, roleId: await roleId(p.role) });
    log.info(`default ${p.username} created`);
  }
}

/** The first Superadmin from SEED_SUPERADMIN_* (see seedUsers). */
async function bootstrapSuperadmin(tx: InTx, owner: ReturnType<typeof ownerOf>, taken: (c: AnyPgColumn, v: string) => Promise<{ id: string }[]>, roleId: (n: string) => Promise<string>) {
  if (!owner) return;
  const superadmin = tx.select({ id: users.id }).from(users).innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId)).where(and(eq(roles.name, SUPERADMIN_ROLE), eq(users.isActive, true))).limit(1);
  if ((await superadmin).length) {
    log.info("an active Superadmin exists: SEED_SUPERADMIN_* skipped");
    return;
  }
  if ((await taken(users.email, owner.email)).length) return;
  if ((await taken(users.username, owner.username)).length) {
    throw new Error("SEED_SUPERADMIN_USERNAME is already the username of another user (with another email). Choose another username.");
  }
  const id = Bun.randomUUIDv7();
  await tx.insert(users).values({ id, name: owner.name, username: owner.username, email: owner.email, passwordHash: await hashPassword(owner.password) });
  await tx.insert(userRoles).values({ userId: id, roleId: await roleId(SUPERADMIN_ROLE) });
}
