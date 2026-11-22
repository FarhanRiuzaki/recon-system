import { PERMISSIONS } from "@starterkit/shared/permissions";
import type { InTx } from "../../kernel/db";
import { permissions } from "../../modules/rbac";

/** Permission seeder: the catalog in order (PERMISSIONS); names already there stay as they are. Idempotent. */
export async function seedPermissions(tx: InTx): Promise<void> {
  await tx.insert(permissions).values(PERMISSIONS.map((name, position) => ({ name, position }))).onConflictDoNothing({ target: permissions.name });
}
