import { sql } from "drizzle-orm";
import { bigint, check, date, foreignKey, index, integer, numeric, pgTable, primaryKey, smallint, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { jsonb } from "../../kernel/columns";
import { reconConfigs } from "../recon/schema";

// The engine's state per config (spec §8 "state per config, not per transaction"): an item per (config, record), the
// runs, and the match groups with their members. Space-owned under row level security (drizzle/0023_engine_rls.sql).
// Ids are UUIDv7: the app makes a run's, PostgreSQL 18's uuidv7() an item's and a group's (set-based writes).
//
// recon_items is partitioned by month of business_date, as records are (drizzle/0009 explains the hand edit of its
// CREATE TABLE in drizzle/0022): S1 measured 3M records per side per day for one config (6M items a day, ~180M a month);
// every pool reads one business-date window (partition pruning), the claim UPDATE is non-HOT on the open index (S1), so
// it stays per month, and retention drops a month instead of deleting rows. A record never changes business date, so
// (config, record, business_date) is unique per record. match_groups and match_members stay plain until their volume
// is measured (a group per two items).
//
// Simulation (spec §10) writes run-scoped rows: items and groups with sim_run_id = its run. Live state is sim_run_id
// null; every engine query names one or the other, so a simulation never reads or changes a live item, and
// deleting its run removes it all (cascade). Chosen over shadow tables: one schema, one compiled SQL, and the draft-vs-
// published diff (Task 3) joins groups of two runs by record.


/**
 * A run of a config's version over business dates `date_from`..`date_to`; `counters` per pass (service.ts RunCounters).
 * `done_through` = the last business date whose step committed (a retried job goes on from the next one); `spec_hash` =
 * the spec it runs (a draft can change while its simulation waits); `baseline_of` = for the published version's
 * simulation a draft's simulation compares with, that simulation's run (deleted with it).
 */
export const reconRuns = pgTable("recon_runs", {
  id: uuid("id").primaryKey(),
  spaceId: uuid("space_id").notNull(),
  configId: uuid("config_id").notNull(),
  /** The version the run is pinned to (no foreign key: recon_config_versions has no (space_id, id) key; it is never deleted). */
  configVersionId: uuid("config_version_id").notNull(),
  mode: text("mode").notNull(),
  dateFrom: date("date_from").notNull(),
  dateTo: date("date_to").notNull(),
  status: text("status").notNull().default("running"),
  counters: jsonb("counters").notNull().default(sql`'{}'::jsonb`),
  error: text("error"),
  specHash: text("spec_hash"),
  doneThrough: date("done_through"),
  baselineOf: uuid("baseline_of"),
  /** The job that runs it (pg-boss id; null = run in process): a run whose job is over while it is not is failed (reaper). */
  jobId: uuid("job_id"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [
  unique("recon_runs_space_id_id_key").on(t.spaceId, t.id),
  index("recon_runs_config_started").on(t.spaceId, t.configId, t.startedAt),
  foreignKey({ name: "recon_runs_config_fkey", columns: [t.spaceId, t.configId], foreignColumns: [reconConfigs.spaceId, reconConfigs.id] }).onDelete("cascade"),
  check("recon_runs_mode_check", sql`${t.mode} in ('manual', 'tick', 'daily', 'rerun', 'simulation')`),
  foreignKey({ name: "recon_runs_baseline_fkey", columns: [t.spaceId, t.baselineOf], foreignColumns: [t.spaceId, t.id] }).onDelete("cascade"),
  check("recon_runs_status_check", sql`${t.status} in ('queued', 'running', 'succeeded', 'failed')`),
  check("recon_runs_window_check", sql`${t.dateFrom} <= ${t.dateTo}`),
]);

/**
 * A record of a side as one config sees it (spec §8): open → matched | suggested | break, then closed. `version` grows
 * with every change of status; a change is `… where status = 'open' and version = $v` (A1), so an item an operator
 * moved meanwhile is skipped. `sim_run_id` = the simulation it belongs to (null = live).
 */
export const reconItems = pgTable("recon_items", {
  id: uuid("id").notNull(),
  spaceId: uuid("space_id").notNull(),
  configId: uuid("config_id").notNull(),
  recordId: uuid("record_id").notNull(),
  side: text("side").notNull(),
  status: text("status").notNull().default("open"),
  businessDate: date("business_date").notNull(),
  breakReason: text("break_reason"),
  version: integer("version").notNull().default(0),
  simRunId: uuid("sim_run_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: "recon_items_pkey", columns: [t.spaceId, t.id, t.businessDate] }),
  unique("recon_items_record_key").on(t.spaceId, t.configId, t.recordId, t.businessDate, t.simRunId).nullsNotDistinct(),
  // the pool of a pass: open items of a config's side in a business-date window, live or of one simulation
  index("recon_items_open").on(t.spaceId, t.configId, t.simRunId, t.side, t.businessDate).where(sql`${t.status} = 'open'`),
  index("recon_items_config_date").on(t.spaceId, t.configId, t.businessDate),
  foreignKey({ name: "recon_items_config_fkey", columns: [t.spaceId, t.configId], foreignColumns: [reconConfigs.spaceId, reconConfigs.id] }).onDelete("cascade"),
  foreignKey({ name: "recon_items_sim_run_fkey", columns: [t.spaceId, t.simRunId], foreignColumns: [reconRuns.spaceId, reconRuns.id] }).onDelete("cascade"),
  check("recon_items_side_check", sql`${t.side} in ('a', 'b')`),
  check("recon_items_status_check", sql`${t.status} in ('open', 'matched', 'suggested', 'break', 'closed')`),
]);

/**
 * A match (spec §8): never deleted (unmatch sets `reversed_by`). `business_date` = the latest of its members' (the day
 * both sides were there): the per-date strip and the day close count it there. `evidence` = per predicate pass/fail and
 * delta, how the pair was chosen, the version and run.
 */
export const matchGroups = pgTable("match_groups", {
  id: uuid("id").primaryKey(),
  spaceId: uuid("space_id").notNull(),
  configId: uuid("config_id").notNull(),
  configVersionId: uuid("config_version_id").notNull(),
  runId: uuid("run_id").notNull(),
  /** The simulation the group belongs to (its run; null = live), as recon_items.sim_run_id. */
  simRunId: uuid("sim_run_id"),
  passNo: smallint("pass_no").notNull(),
  kind: text("kind").notNull(),
  score: numeric("score"),
  businessDate: date("business_date").notNull(),
  evidence: jsonb("evidence").notNull(),
  reversedBy: uuid("reversed_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("match_groups_space_id_id_key").on(t.spaceId, t.id),
  index("match_groups_config_date").on(t.spaceId, t.configId, t.businessDate),
  index("match_groups_run").on(t.spaceId, t.runId, t.passNo),
  foreignKey({ name: "match_groups_config_fkey", columns: [t.spaceId, t.configId], foreignColumns: [reconConfigs.spaceId, reconConfigs.id] }).onDelete("cascade"),
  foreignKey({ name: "match_groups_run_fkey", columns: [t.spaceId, t.runId], foreignColumns: [reconRuns.spaceId, reconRuns.id] }).onDelete("cascade"),
  foreignKey({ name: "match_groups_sim_run_fkey", columns: [t.spaceId, t.simRunId], foreignColumns: [reconRuns.spaceId, reconRuns.id] }).onDelete("cascade"),
  check("match_groups_kind_check", sql`${t.kind} in ('auto', 'suggested', 'manual', 'force')`),
]);

/** An item of a group, with its signed amount (signedAmount's rule) at the time. No foreign key to the partitioned items. */
export const matchMembers = pgTable("match_members", {
  groupId: uuid("group_id").notNull(),
  spaceId: uuid("space_id").notNull(),
  itemId: uuid("item_id").notNull(),
  side: text("side").notNull(),
  signedAmount: bigint("signed_amount", { mode: "bigint" }),
}, (t) => [
  primaryKey({ name: "match_members_pkey", columns: [t.spaceId, t.groupId, t.itemId] }),
  index("match_members_item").on(t.spaceId, t.itemId),
  foreignKey({ name: "match_members_group_fkey", columns: [t.spaceId, t.groupId], foreignColumns: [matchGroups.spaceId, matchGroups.id] }).onDelete("cascade"),
  check("match_members_side_check", sql`${t.side} in ('a', 'b')`),
]);

/**
 * What a draft's simulation changes against the published version's simulation over the same dates (spec §10), one row
 * per changed pair of groups, written by the simulation's job: `gained` (a draft group sharing no record with a
 * published one), `lost` (the other way round), `repaired` (a draft group and a published one sharing some records but
 * not all), `kind` (the same records, auto in one and suggested in the other). Deleted with the simulation's run.
 */
export const reconSimChanges = pgTable("recon_sim_changes", {
  id: uuid("id").primaryKey(),
  spaceId: uuid("space_id").notNull(),
  runId: uuid("run_id").notNull(),
  change: text("change").notNull(),
  draftGroupId: uuid("draft_group_id"),
  publishedGroupId: uuid("published_group_id"),
  businessDate: date("business_date").notNull(),
}, (t) => [
  index("recon_sim_changes_run").on(t.spaceId, t.runId, t.change, t.businessDate),
  foreignKey({ name: "recon_sim_changes_run_fkey", columns: [t.spaceId, t.runId], foreignColumns: [reconRuns.spaceId, reconRuns.id] }).onDelete("cascade"),
  check("recon_sim_changes_change_check", sql`${t.change} in ('gained', 'lost', 'repaired', 'kind')`),
]);
