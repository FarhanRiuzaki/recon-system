import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { jsonb } from "../../kernel/columns";
import { sources } from "../sources/schema";
import { spaces } from "../spaces/schema";

// Space-owned tables (space_id in every key and foreign key, spec §8) under row level security: the standard space
// policy, plus one read-only policy on recon_source_uses for the space that owns the source (drizzle/0021_recon_rls.sql).
// Ids are UUIDv7 made by the app. maker_id / contributor_ids / submitted_by / checker_id have no foreign key: a deleted
// user's versions keep who made them. A side's source may belong to another space that shares it (DEC-042).

/** A recon config of a space; its code is unique in the space (stored lower case). */
export const reconConfigs = pgTable("recon_configs", {
  id: uuid("id").primaryKey(),
  spaceId: uuid("space_id").notNull(),
  code: text("code").notNull(),
  name: text("name").notNull(),
  status: text("status").notNull().default("active"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("recon_configs_space_id_id_key").on(t.spaceId, t.id),
  uniqueIndex("recon_configs_space_id_code_key").on(t.spaceId, t.code),
  foreignKey({ name: "recon_configs_space_id_fkey", columns: [t.spaceId], foreignColumns: [spaces.id] }).onDelete("cascade"),
  check("recon_configs_status_check", sql`${t.status} in ('active', 'paused')`),
]);

/**
 * Versions of a config's spec (ReconSpec): at most one open (draft or in review) and one published per config;
 * publishing retires the one before. `simulated_hash` = the spec hash its last simulation ran on (Plan 3 Task 3).
 */
export const reconConfigVersions = pgTable("recon_config_versions", {
  id: uuid("id").primaryKey(),
  configId: uuid("config_id").notNull(),
  spaceId: uuid("space_id").notNull(),
  version: integer("version").notNull(),
  status: text("status").notNull(),
  spec: jsonb("spec").notNull(),
  specHash: text("spec_hash").notNull(),
  makerId: uuid("maker_id"),
  /** Everyone who created, edited (spec changed) or submitted this version, in order; none of them may check it. */
  contributorIds: uuid("contributor_ids").array().notNull().default(sql`'{}'`),
  submittedBy: uuid("submitted_by"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  checkerId: uuid("checker_id"),
  reviewComment: text("review_comment"),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  simulatedHash: text("simulated_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("recon_config_versions_version_key").on(t.spaceId, t.configId, t.version),
  uniqueIndex("recon_config_versions_open_key").on(t.spaceId, t.configId).where(sql`${t.status} in ('draft', 'in_review')`),
  uniqueIndex("recon_config_versions_published_key").on(t.spaceId, t.configId).where(sql`${t.status} = 'published'`),
  foreignKey({ name: "recon_config_versions_config_fkey", columns: [t.spaceId, t.configId], foreignColumns: [reconConfigs.spaceId, reconConfigs.id] }).onDelete("cascade"),
  check("recon_config_versions_status_check", sql`${t.status} in ('draft', 'in_review', 'published', 'retired')`),
]);

/**
 * The fields of a source each published config reads (Plan 3 A4), rewritten when a version is published, so the space
 * that owns the source can refuse a source version that drops or retypes one of them, also for a config of a space it
 * shares the source to. `config_name` is the name the refusal lists (the owner space can't read the config itself).
 */
export const reconSourceUses = pgTable("recon_source_uses", {
  spaceId: uuid("space_id").notNull(),
  configId: uuid("config_id").notNull(),
  sourceSpaceId: uuid("source_space_id").notNull(),
  sourceId: uuid("source_id").notNull(),
  field: text("field").notNull(),
  configName: text("config_name").notNull(),
}, (t) => [
  primaryKey({ name: "recon_source_uses_pkey", columns: [t.spaceId, t.configId, t.sourceId, t.field] }),
  foreignKey({ name: "recon_source_uses_config_fkey", columns: [t.spaceId, t.configId], foreignColumns: [reconConfigs.spaceId, reconConfigs.id] }).onDelete("cascade"),
  foreignKey({ name: "recon_source_uses_source_fkey", columns: [t.sourceSpaceId, t.sourceId], foreignColumns: [sources.spaceId, sources.id] }).onDelete("cascade"),
  index("recon_source_uses_source").on(t.sourceSpaceId, t.sourceId, t.field),
]);
