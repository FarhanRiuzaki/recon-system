import { eq } from "drizzle-orm";
import { PERMISSIONS, type PermissionName, SUPERADMIN_ROLE } from "@starterkit/shared/permissions";
import type { InTx } from "../../kernel/db";
import { permissions, rolePermissions, roles } from "../../modules/rbac";

/**
 * The built-in global roles. Superadmin holds every permission and opens every space (isSuperadmin). Maker and Approver
 * are the default people of the maker-checker flow (owner, 22 Nov): what they may do in a space comes from their space
 * roles (the local seed gives maker source_admin + config_maker, approver config_checker); globally they read users and
 * the activity log, as Viewer.
 */
export const ROLES: { name: string; locked: boolean; perms: readonly PermissionName[] }[] = [
  { name: SUPERADMIN_ROLE, locked: true, perms: PERMISSIONS },
  { name: "Admin", locked: false, perms: PERMISSIONS.filter((p) => !p.startsWith("role.") && !p.startsWith("permission.")) },
  { name: "Viewer", locked: false, perms: ["user.view", "audit.view"] },
  { name: "Maker", locked: false, perms: ["user.view", "audit.view"] },
  { name: "Approver", locked: false, perms: ["user.view", "audit.view"] },
];

/**
 * Role seeder (after seedPermissions): each built-in role, its permissions only when the role is created (later edits
 * stay), and Superadmin always every permission in the catalog. Idempotent.
 */
export async function seedRoles(tx: InTx): Promise<void> {
  for (const r of ROLES) {
    // The only possible conflict is the name (lower(name) index): the id is new.
    const [made] = await tx.insert(roles).values({ id: Bun.randomUUIDv7(), name: r.name, locked: r.locked }).onConflictDoNothing().returning({ id: roles.id });
    if (made) await tx.insert(rolePermissions).values(r.perms.map((permission) => ({ roleId: made.id, permission })));
  }
  await tx.insert(rolePermissions)
    .select(tx.select({ roleId: roles.id, permission: permissions.name }).from(roles).crossJoin(permissions).where(eq(roles.name, SUPERADMIN_ROLE)))
    .onConflictDoNothing();
}
