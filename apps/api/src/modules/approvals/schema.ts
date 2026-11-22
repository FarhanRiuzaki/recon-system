import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { jsonb } from "../../kernel/columns";
import { reconConfigs } from "../recon/schema";

// The approval workflow engine (DEC-052 rev 2: docs/superpowers/specs/2026-11-22-recon-approval-and-posting-design.md):
// each space's workflows (named chains of levels, versioned, space-owned under row level security), the requests they
// route and every decision on them. Which workflow a change takes lives in the recon version (recon module).
// Migrations: drizzle/0048_approval_workflows.sql, 0049_workflow_library.sql, 0050_workflows_per_space.sql.

const versionColumns = {
  version: integer("version").notNull(),
  status: text("status").notNull().default("draft"),
  spec: jsonb("spec").notNull(),
  makerId: uuid("maker_id"),
  submittedBy: uuid("submitted_by"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  decidedBy: uuid("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  reviewComment: text("review_comment"),
  /** A Superadmin published their own version by override, with this reason (DEC-052). */
  overrideReason: text("override_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

/** A space's workflow: `name` follows its published version (its draft's until one is published), unique in the space. */
export const workflows = pgTable("workflows", {
  id: uuid("id").primaryKey(),
  spaceId: uuid("space_id").notNull(),
  name: text("name").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("workflows_space_name").on(t.spaceId, sql`lower(${t.name})`)]);

/**
 * One version of a space's workflow: `spec` = ChainSpec (name and levels). draft → in_review → published (the one
 * before retired); a space admin or workflow.manage holder edits, another one publishes. One open and one published per
 * workflow.
 */
export const workflowVersions = pgTable("workflow_versions", {
  id: uuid("id").primaryKey(),
  spaceId: uuid("space_id").notNull(),
  workflowId: uuid("workflow_id").notNull().references(() => workflows.id, { onDelete: "cascade" }),
  ...versionColumns,
}, (t) => [
  uniqueIndex("workflow_versions_one_open").on(t.workflowId).where(sql`${t.status} in ('draft', 'in_review')`),
  uniqueIndex("workflow_versions_one_published").on(t.workflowId).where(sql`${t.status} = 'published'`),
  uniqueIndex("workflow_versions_version").on(t.workflowId, t.version),
  check("workflow_versions_status_check", sql`status in ('draft', 'in_review', 'published', 'retired')`),
]);

/**
 * A change someone asked for and the chain that decides it (DEC-052). `chain` = the levels of the workflow the request
 * took (snapshot: a later workflow or rules change never moves it); `current_level` = the level waiting (0-based). For a break:
 * `item_id` the break, `item_ids` a force match's other items, `prev_state` its queue state to go back to. `label` =
 * the subject as the inbox names it. One pending request per subject (approval_requests_one_pending).
 */
export const approvalRequests = pgTable("approval_requests", {
  id: uuid("id").primaryKey(),
  spaceId: uuid("space_id").notNull(),
  configId: uuid("config_id").notNull(),
  kind: text("kind").notNull(),
  itemId: uuid("item_id").notNull(),
  itemIds: uuid("item_ids").array().notNull().default(sql`'{}'::uuid[]`),
  label: text("label").notNull(),
  note: text("note").notNull(),
  prevState: text("prev_state"),
  status: text("status").notNull().default("pending"),
  requestedBy: uuid("requested_by"),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
  decidedBy: uuid("decided_by"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decisionNote: text("decision_note"),
  attributes: jsonb("attributes").notNull().default(sql`'{}'::jsonb`),
  /** The workflow version, the recon version whose approval setup chose it, and the names it was opened with (snapshot). */
  workflowVersionId: uuid("workflow_version_id"),
  configVersionId: uuid("config_version_id"),
  workflowName: text("workflow_name"),
  ruleName: text("rule_name"),
  chain: jsonb("chain").notNull().default(sql`'[]'::jsonb`),
  currentLevel: smallint("current_level").notNull().default(0),
}, (t) => [
  uniqueIndex("approval_requests_one_pending").on(t.spaceId, t.itemId).where(sql`${t.status} = 'pending'`),
  index("approval_requests_inbox").on(t.spaceId, t.status, t.requestedAt),
  foreignKey({ name: "approval_requests_config_fkey", columns: [t.spaceId, t.configId], foreignColumns: [reconConfigs.spaceId, reconConfigs.id] }).onDelete("cascade"),
  check("approval_requests_kind_check", sql`kind in ('force_match', 'unmatch', 'write_off', 'posting')`),
  check("approval_requests_status_check", sql`status in ('pending', 'approved', 'rejected', 'cancelled')`),
]);

/**
 * One decision on a request: an approval counts for one group of its level (`group_index`); a reject ends the request;
 * an override (a Superadmin, with a reason) approves what is left. One decision per person per request (SoD floor).
 */
export const approvalDecisions = pgTable("approval_decisions", {
  id: uuid("id").primaryKey(),
  spaceId: uuid("space_id").notNull(),
  requestId: uuid("request_id").notNull().references(() => approvalRequests.id, { onDelete: "cascade" }),
  level: smallint("level").notNull(),
  groupIndex: smallint("group_index"),
  userId: uuid("user_id").notNull(),
  decision: text("decision").notNull(),
  note: text("note"),
  override: boolean("override").notNull().default(false),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex("approval_decisions_one_per_person").on(t.requestId, t.userId),
  index("approval_decisions_request").on(t.requestId, t.level),
  check("approval_decisions_decision_check", sql`decision in ('approve', 'reject')`),
]);
