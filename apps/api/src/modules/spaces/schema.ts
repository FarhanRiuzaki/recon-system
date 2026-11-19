import { sql } from "drizzle-orm";
import { check, foreignKey, index, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "../users/schema";

// A space isolates one team's recon data; codes are unique ignoring letter case.
export const spaces = pgTable("spaces", {
  id: uuid("id").primaryKey(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("spaces_code_key").on(sql`lower(${t.code})`),
  check("spaces_status_check", sql`${t.status} in ('active', 'archived')`),
]);

/** One row per role a user holds in a space (several roles per user allowed). The role list is SPACE_ROLES (@starterkit/shared/spaces). */
export const spaceMembers = pgTable("space_members", {
  spaceId: uuid("space_id").notNull(),
  userId: uuid("user_id").notNull(),
  role: text("role").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: "space_members_pkey", columns: [t.spaceId, t.userId, t.role] }),
  foreignKey({ name: "space_members_space_id_fkey", columns: [t.spaceId], foreignColumns: [spaces.id] }).onDelete("cascade"),
  foreignKey({ name: "space_members_user_id_fkey", columns: [t.userId], foreignColumns: [users.id] }).onDelete("cascade"),
  index("space_members_user_id").on(t.userId),
  check("space_members_role_check", sql`${t.role} in ('space_admin', 'source_admin', 'config_maker', 'config_checker', 'operator', 'reviewer', 'viewer')`),
]);
