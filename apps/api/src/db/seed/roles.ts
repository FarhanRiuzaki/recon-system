import { eq } from "drizzle-orm";
import { PERMISSIONS, type PermissionName, SUPERADMIN_ROLE } from "@starterkit/shared/permissions";
import type { InTx } from "../../kernel/db";
import { permissions, rolePermissions, roles } from "../../modules/rbac";

export type SeedRole = { name: string; locked: boolean; perms: readonly PermissionName[] };

/**
 * The built-in global roles (owner, 22 Nov: Superadmin, Maker, Approver; 24 Nov: Open API operator and admin).
 * Superadmin holds every permission and opens every space (isSuperadmin). Maker and Approver are the default people of
 * the maker-checker flow: what they may do in a space comes from their space roles (the local seed gives maker
 * source_admin + config_maker, approver config_checker); globally they read users and the activity log. None is
 * locked but Superadmin, so a later edit on the roles screen stays (ensureRoles).
 */
export const ROLES: SeedRole[] = [
  { name: SUPERADMIN_ROLE, locked: true, perms: PERMISSIONS },
  { name: "Maker", locked: false, perms: ["user.view", "audit.view"] },
  { name: "Approver", locked: false, perms: ["user.view", "audit.view"] },
  // Open API (DEC-053): an operator reads connectors and their call log, a call in full too; an admin also edits connectors
  { name: "Open API operator", locked: false, perms: ["integration.view", "integration.debug"] },
  { name: "Open API admin", locked: false, perms: ["integration.view", "integration.manage", "integration.debug"] },
];

/** Each of `list` made when missing, with its permissions only then (later edits stay). */
export async function ensureRoles(tx: InTx, list: readonly SeedRole[]): Promise<void> {
  for (const r of list) {
    // The only possible conflict is the name (lower(name) index): the id is new.
    const [made] = await tx.insert(roles).values({ id: Bun.randomUUIDv7(), name: r.name, locked: r.locked }).onConflictDoNothing().returning({ id: roles.id });
    if (made) await tx.insert(rolePermissions).values(r.perms.map((permission) => ({ roleId: made.id, permission })));
  }
}

/** Role seeder (after seedPermissions): ROLES, and Superadmin always every permission in the catalog. Idempotent. */
export async function seedRoles(tx: InTx): Promise<void> {
  await ensureRoles(tx, ROLES);
  await tx.insert(rolePermissions)
    .select(tx.select({ roleId: roles.id, permission: permissions.name }).from(roles).crossJoin(permissions).where(eq(roles.name, SUPERADMIN_ROLE)))
    .onConflictDoNothing();
}
