import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, foreignKey, index, integer, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { jsonb } from "../../kernel/columns";
import { reconConfigs } from "../recon/schema";

const stamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

/** A recon's report template (the report generator, DEC-060); `retired_at` set = it makes no more files. */
export const reportTemplates = pgTable("report_templates", {
  id: uuid("id").primaryKey(),
  spaceId: uuid("space_id").notNull(),
  configId: uuid("config_id").notNull(),
  name: text("name").notNull(),
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  createdBy: uuid("created_by"),
  ...stamps,
}, (t) => [
  unique("report_templates_space_id_key").on(t.spaceId, t.id),
  index("report_templates_config_idx").on(t.spaceId, t.configId),
  foreignKey({ name: "report_templates_config_fkey", columns: [t.spaceId, t.configId], foreignColumns: [reconConfigs.spaceId, reconConfigs.id] }).onDelete("cascade"),
]);

/**
 * A template's version: draft → waiting (official: a config checker decides) → active; an active one becomes
 * superseded when the next is active. Sent back, a version is a draft again with the checker's note. At most one draft
 * or waiting and one active per template. `contributor_ids` = who made, edited or sent it (none of them may approve it).
 */
export const reportVersions = pgTable("report_template_versions", {
  id: uuid("id").primaryKey(),
  spaceId: uuid("space_id").notNull(),
  templateId: uuid("template_id").notNull(),
  version: integer("version").notNull(),
  status: text("status").notNull(),
  spec: jsonb("spec").notNull(),
  makerId: uuid("maker_id"),
  contributorIds: uuid("contributor_ids").array().notNull().default(sql`'{}'`),
  submittedBy: uuid("submitted_by"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  checkerId: uuid("checker_id"),
  note: text("note"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  ...stamps,
}, (t) => [
  unique("report_template_versions_version_key").on(t.spaceId, t.templateId, t.version),
  uniqueIndex("report_template_versions_open_key").on(t.spaceId, t.templateId).where(sql`${t.status} in ('draft', 'waiting')`),
  uniqueIndex("report_template_versions_active_key").on(t.spaceId, t.templateId).where(sql`${t.status} = 'active'`),
  foreignKey({ name: "report_template_versions_template_fkey", columns: [t.spaceId, t.templateId], foreignColumns: [reportTemplates.spaceId, reportTemplates.id] }).onDelete("cascade"),
  check("report_template_versions_status_check", sql`${t.status} in ('draft', 'waiting', 'active', 'superseded')`),
]);

/**
 * A report file: asked by a user (`asked_by`) or made after a run (`run_id`, one per template and run); `dates` = each
 * business date and whether it was signed off when read (Final); `file_version` counts files of one template over the
 * same dates. The file itself is on disk under the space's inbox root (`.reports/<id>.<ext>`); `removed` after retention.
 */
export const reportFiles = pgTable("report_files", {
  id: uuid("id").primaryKey(),
  spaceId: uuid("space_id").notNull(),
  templateId: uuid("template_id").notNull(),
  versionId: uuid("version_id").notNull(),
  configId: uuid("config_id").notNull(),
  fromDate: date("from_date").notNull(),
  toDate: date("to_date").notNull(),
  format: text("format").notNull(),
  masking: text("masking").notNull(),
  status: text("status").notNull(),
  progress: integer("progress").notNull().default(0),
  fileName: text("file_name").notNull(),
  fileVersion: integer("file_version").notNull().default(1),
  final: boolean("final").notNull().default(false),
  dates: jsonb("dates").notNull().default(sql`'[]'::jsonb`),
  rows: integer("rows"),
  size: bigint("size", { mode: "number" }),
  sha256: text("sha256"),
  askedBy: uuid("asked_by"),
  runId: uuid("run_id"),
  error: text("error"),
  readAt: timestamp("read_at", { withTimezone: true }),
  readyAt: timestamp("ready_at", { withTimezone: true }),
  removedAt: timestamp("removed_at", { withTimezone: true }),
  ...stamps,
}, (t) => [
  uniqueIndex("report_files_run_key").on(t.spaceId, t.templateId, t.runId).where(sql`${t.runId} is not null`),
  index("report_files_list_idx").on(t.spaceId, t.createdAt),
  index("report_files_template_idx").on(t.spaceId, t.templateId, t.fromDate, t.toDate),
  foreignKey({ name: "report_files_template_fkey", columns: [t.spaceId, t.templateId], foreignColumns: [reportTemplates.spaceId, reportTemplates.id] }).onDelete("cascade"),
  check("report_files_status_check", sql`${t.status} in ('queued', 'making', 'ready', 'failed', 'removed')`),
  check("report_files_format_check", sql`${t.format} in ('csv', 'xlsx', 'pdf')`),
  check("report_files_masking_check", sql`${t.masking} in ('masked', 'full')`),
]);
