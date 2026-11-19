// Row level security tests: the test database connects as a superuser, which skips every policy, so a test that doesn't
// switch roles passes whatever the policy says.
import { sql } from "drizzle-orm";
import { integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
import type { Tx } from "../../src/kernel/db";

/**
 * Switches `tx`, until it ends, to `recon_app_probe` (NOLOGIN, no BYPASSRLS, DML on every table of the current schema),
 * creating it when missing. Temp tables get no grant from here: a test grants on its own.
 */
export async function asAppRole(tx: Tx): Promise<void> {
  await tx.execute(sql.raw(`do $$
begin
  begin
    create role recon_app_probe nologin nosuperuser nobypassrls;
  exception when duplicate_object or unique_violation then null; -- another test file made it first
  end;
  alter role recon_app_probe nologin nosuperuser nobypassrls;
  execute format('grant usage on schema %I to recon_app_probe', current_schema());
  execute format('grant select, insert, update, delete on all tables in schema %I to recon_app_probe', current_schema());
end
$$`));
  await tx.execute(sql`set local role recon_app_probe`);
}

/**
 * A space-owned table for policy tests, as a test creates it in pg_temp (`create temp table probe …`); declared here
 * because src/ allows tables only in a module's schema.ts and queries only through the builder.
 */
export const probe = pgTable("probe", { spaceId: uuid("space_id").notNull(), ref: text("ref").notNull() });

/** A second space-owned table for the index test (`create temp table probe_ix …`), declared here for the same reason. */
export const probeIx = pgTable("probe_ix", { spaceId: uuid("space_id").notNull(), x: integer("x").notNull() });
