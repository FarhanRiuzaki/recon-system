import { sql } from "drizzle-orm";
import { check, date, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { jsonb } from "../../kernel/columns";
import { spaces } from "../spaces/schema";

// Space-owned tables (space_id in every key and foreign key, spec §8) under row level security: the standard space
// policy, plus read-only policies that let the space a source is shared to read it (drizzle/0011_sources_rls.sql).
// Ids are UUIDv7 made by the app. maker_id / contributor_ids / submitted_by / checker_id have no foreign key: a deleted user's versions
// keep who made them.

const stamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

/** A source of a space; its code is unique in the space (stored lower case). */
export const sources = pgTable("sources", {
  id: uuid("id").primaryKey(),
  spaceId: uuid("space_id").notNull(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  status: text("status").notNull().default("active"),
  ...stamps,
}, (t) => [
  unique("sources_space_id_id_key").on(t.spaceId, t.id),
  uniqueIndex("sources_space_id_code_key").on(t.spaceId, t.code),
  foreignKey({ name: "sources_space_id_fkey", columns: [t.spaceId], foreignColumns: [spaces.id] }).onDelete("cascade"),
  check("sources_kind_check", sql`${t.kind} in ('db_watermark', 'db_snapshot', 'file_inbox')`),
  check("sources_status_check", sql`${t.status} in ('active', 'paused')`),
]);

/** A DB source's credential: `secret_enc` = encryptSecret(JSON { host, port, database, user, password }); never answered. */
export const sourceConnections = pgTable("source_connections", {
  spaceId: uuid("space_id").notNull(),
  sourceId: uuid("source_id").notNull(),
  engine: text("engine").notNull(),
  secretEnc: text("secret_enc").notNull(),
  options: jsonb("options").notNull(),
  ...stamps,
}, (t) => [
  primaryKey({ name: "source_connections_pkey", columns: [t.spaceId, t.sourceId] }),
  foreignKey({ name: "source_connections_source_fkey", columns: [t.spaceId, t.sourceId], foreignColumns: [sources.spaceId, sources.id] }).onDelete("cascade"),
  check("source_connections_engine_check", sql`${t.engine} in ('postgres', 'mysql', 'mssql', 'oracle')`),
]);

/**
 * Versions of a source's spec: at most one open (draft or in review) and one published per source (partial unique
 * indexes); publishing retires the one before.
 */
export const sourceVersions = pgTable("source_versions", {
  id: uuid("id").primaryKey(),
  spaceId: uuid("space_id").notNull(),
  sourceId: uuid("source_id").notNull(),
  version: integer("version").notNull(),
  status: text("status").notNull(),
  spec: jsonb("spec"),
  specHash: text("spec_hash"),
  makerId: uuid("maker_id"),
  /** Everyone who created, edited (spec changed) or submitted this version, in order; none of them may check it. */
  contributorIds: uuid("contributor_ids").array().notNull().default(sql`'{}'`),
  /** Who sent it to review last, and when (kept through a reject until the next submit). */
  submittedBy: uuid("submitted_by"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  checkerId: uuid("checker_id"),
  reviewComment: text("review_comment"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  ...stamps,
}, (t) => [
  unique("source_versions_version_key").on(t.spaceId, t.sourceId, t.version),
  uniqueIndex("source_versions_open_key").on(t.spaceId, t.sourceId).where(sql`${t.status} in ('draft', 'in_review')`),
  uniqueIndex("source_versions_published_key").on(t.spaceId, t.sourceId).where(sql`${t.status} = 'published'`),
  foreignKey({ name: "source_versions_source_fkey", columns: [t.spaceId, t.sourceId], foreignColumns: [sources.spaceId, sources.id] }).onDelete("cascade"),
  check("source_versions_status_check", sql`${t.status} in ('draft', 'in_review', 'published', 'retired')`),
]);

/** A source of `space_id` shared read-only to `to_space_id`. */
export const sourceShares = pgTable("source_shares", {
  spaceId: uuid("space_id").notNull(),
  sourceId: uuid("source_id").notNull(),
  toSpaceId: uuid("to_space_id").notNull(),
  createdAt: stamps.createdAt,
}, (t) => [
  primaryKey({ name: "source_shares_pkey", columns: [t.spaceId, t.sourceId, t.toSpaceId] }),
  foreignKey({ name: "source_shares_source_fkey", columns: [t.spaceId, t.sourceId], foreignColumns: [sources.spaceId, sources.id] }).onDelete("cascade"),
  foreignKey({ name: "source_shares_to_space_id_fkey", columns: [t.toSpaceId], foreignColumns: [spaces.id] }).onDelete("cascade"),
  index("source_shares_to_space_id").on(t.toSpaceId, t.sourceId),
  check("source_shares_not_self", sql`${t.toSpaceId} <> ${t.spaceId}`),
]);

/**
 * Business-day calendars, global (no space: every space picks one by code in a source spec). `weekend` = ISO days off
 * (1 Monday … 7 Sunday); `holidays` = dates off. The system seed adds `id-default`.
 */
export const calendars = pgTable("calendars", {
  id: uuid("id").primaryKey(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  weekend: integer("weekend").array().notNull(),
  holidays: date("holidays").array().notNull().default(sql`'{}'`),
  ...stamps,
}, (t) => [
  uniqueIndex("calendars_code_key").on(t.code),
  check("calendars_weekend_check", sql`${t.weekend} <@ array[1, 2, 3, 4, 5, 6, 7]`),
]);
