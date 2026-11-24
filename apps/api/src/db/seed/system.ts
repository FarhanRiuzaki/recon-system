import { DEFAULT_CALENDAR } from "@starterkit/shared/sources";
import type { Tx } from "../../kernel/db";
import { calendars } from "../../modules/sources";
import { seedPermissions } from "./permissions";
import { seedRoles } from "./roles";
import { seedUsers } from "./users";

/**
 * The data every install needs, idempotent, in one transaction: the permission seeder (permissions.ts), the role
 * seeder (roles.ts: Superadmin, Maker, Approver, Open API operator, Open API admin), the business-day calendar `id-default`, then the user
 * seeder (users.ts: the first Superadmin from SEED_SUPERADMIN_*, the default maker and approver from
 * SEED_MAKER_PASSWORD / SEED_APPROVER_PASSWORD).
 */
export async function seedSystem(db: Tx, env: Record<string, string | undefined>): Promise<void> {
  await db.transaction(async (tx) => {
    await seedPermissions(tx);
    await seedRoles(tx);
    // The calendar every source can start from (ISO days: 6 Saturday, 7 Sunday); later edits stay.
    await tx.insert(calendars).values({ id: Bun.randomUUIDv7(), code: DEFAULT_CALENDAR, name: "Indonesia (Saturday and Sunday off)", weekend: [6, 7], holidays: [] })
      .onConflictDoNothing();
    await seedUsers(tx, env);
  });
}
