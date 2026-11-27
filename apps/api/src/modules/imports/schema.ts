import { sql } from "drizzle-orm";
import { boolean, check, date, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { jsonb } from "../../kernel/columns";

// The Import section (DEC-066). Global tables (no space): staging is one shared database. Ids are UUIDv7 made by the app.
// updated_by / user_id have no foreign key: a deleted user's rows keep who made them. The stg_* tables and
// import_file_history live in the staging database (staging/), not here.

/** A feed: one kind of rows loaded per MIS date into one staging table, under one import_file_history source. */
export const importFeeds = pgTable("import_feeds", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("db_host"),
  /** ImportFeedSpec (contracts/imports.ts); may be incomplete while the scheduler is off. */
  spec: jsonb("spec").notNull(),
  schedulerOn: boolean("scheduler_on").notNull().default(false),
  /** Whether the target table was created from the screen or an existing one adopted. */
  tableState: text("table_state").notNull().default("missing"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid("updated_by"),
}, (t) => [
  uniqueIndex("import_feeds_name_key").on(sql`lower(${t.name})`),
  // one feed per history source: two feeds on one source would share its dates and its PROCESSING lock
  uniqueIndex("import_feeds_history_source_key").on(sql`(${t.spec} ->> 'historySource')`),
  check("import_feeds_kind_check", sql`${t.kind} in ('db_host')`),
  check("import_feeds_table_state_check", sql`${t.tableState} in ('missing', 'created', 'adopted')`),
]);

/** One execution of a feed's job, also when it found no date to do (so a missed run can be told from an idle one). */
export const importRuns = pgTable("import_runs", {
  id: uuid("id").primaryKey(),
  feedId: uuid("feed_id").notNull().references(() => importFeeds.id, { onDelete: "cascade" }),
  trigger: text("trigger").notNull(),
  /** The run time it was scheduled for; null for a manual run. */
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  /** Written every 30 s while running; an old one on a running row = stuck. */
  heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  status: text("status").notNull().default("running"),
  dates: integer("dates").notNull().default(0),
  message: text("message"),
  userId: uuid("user_id"),
}, (t) => [
  index("import_runs_feed_started").on(t.feedId, t.startedAt.desc()),
  index("import_runs_running").on(t.feedId).where(sql`${t.status} = 'running'`),
  check("import_runs_trigger_check", sql`${t.trigger} in ('schedule', 'manual')`),
  check("import_runs_status_check", sql`${t.status} in ('running', 'done', 'failed', 'crashed')`),
]);

/** One look at one MIS date of a feed: NOT READY included, which import_file_history never records. */
export const importChecks = pgTable("import_checks", {
  id: uuid("id").primaryKey(),
  feedId: uuid("feed_id").notNull().references(() => importFeeds.id, { onDelete: "cascade" }),
  runId: uuid("run_id"),
  fileDate: date("file_date").notNull(),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  trigger: text("trigger").notNull(),
  result: text("result").notNull(),
  rows: integer("rows"),
  inserted: integer("inserted"),
  replaced: integer("replaced"),
  /** The import_file_history row it wrote or found (staging), when there is one. */
  historyId: uuid("history_id"),
  message: text("message"),
  userId: uuid("user_id"),
}, (t) => [
  index("import_checks_feed_date").on(t.feedId, t.fileDate, t.at.desc()),
  index("import_checks_at").on(t.at),
  check("import_checks_trigger_check", sql`${t.trigger} in ('schedule', 'manual')`),
  check("import_checks_result_check", sql`${t.result} in ('not_ready', 'imported', 'skipped', 'failed', 'dry_run')`),
]);
