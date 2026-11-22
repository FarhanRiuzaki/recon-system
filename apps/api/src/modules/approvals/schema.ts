import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { jsonb } from "../../kernel/columns";
import { reconConfigs } from "../recon/schema";

// The approval workflow engine (DEC-052): a space's workflows per action, versioned like a recon's config; the requests
// they route and every decision on them. Space-owned under row level security (drizzle/0048_approval_workflows.sql).

/**
 * One version of a space's workflow for one action (WORKFLOW_ACTIONS): `spec` = its rules (WorkflowSpec). draft →
 * in_review → published (the one before retired); a draft is edited by a space admin or a workflow.manage holder and
 * published by another one (DEC-052 §4.6: the workflow of workflows is fixed in code). One open version (draft or in
 * review) and one published per action, by partial unique indexes.
 */
export const approvalWorkflows = pgTable("approval_workflows", {
  id: uuid("id").primaryKey(),
  spaceId: uuid("space_id").notNull(),
  action: text("action").notNull(),
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
}, (t) => [
  uniqueIndex("approval_workflows_one_open").on(t.spaceId, t.action).where(sql`${t.status} in ('draft', 'in_review')`),
  uniqueIndex("approval_workflows_one_published").on(t.spaceId, t.action).where(sql`${t.status} = 'published'`),
  uniqueIndex("approval_workflows_version").on(t.spaceId, t.action, t.version),
  check("approval_workflows_status_check", sql`status in ('draft', 'in_review', 'published', 'retired')`),
]);

/**
 * A change someone asked for and the chain that decides it (DEC-052). `chain` = the levels of the rule the request took
 * (snapshot: a later workflow change never moves it); `current_level` = the level waiting (0-based). For a break:
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
  workflowVersionId: uuid("workflow_version_id"),
  ruleName: text("rule_name"),
  chain: jsonb("chain").notNull().default(sql`'[]'::jsonb`),
  currentLevel: smallint("current_level").notNull().default(0),
}, (t) => [
  uniqueIndex("approval_requests_one_pending").on(t.spaceId, t.itemId).where(sql`${t.status} = 'pending'`),
  index("approval_requests_inbox").on(t.spaceId, t.status, t.requestedAt),
  foreignKey({ name: "approval_requests_config_fkey", columns: [t.spaceId, t.configId], foreignColumns: [reconConfigs.spaceId, reconConfigs.id] }).onDelete("cascade"),
  check("approval_requests_kind_check", sql`kind in ('force_match', 'unmatch', 'write_off')`),
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
