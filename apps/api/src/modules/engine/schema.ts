import { sql } from "drizzle-orm";
import { bigint, boolean, check, date, foreignKey, index, integer, numeric, pgTable, primaryKey, smallint, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { jsonb } from "../../kernel/columns";
import { reconConfigs, reconConfigVersions } from "../recon/schema";

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
  /**
   * The last side intake committed, as "<business date>:<side>" ("2026-11-02:a" < "2026-11-02:b" < "2026-11-03:a" as
   * text): a step's intake commits before its passes (statistics in between), and a second delivery skips it.
   */
  intakeDone: text("intake_done"),
  /** Per business date and pass what the run left (ReconRunDto.days), written when it succeeds; null before (and for runs before 0032). */
  days: jsonb("days"),
  /**
   * Its days and its passes' references-once fix are written (finalizeRun): false until then, and again when a refresh
   * after its close failed. A GET of a succeeded run not finalized answers no days and queues finalizeRun.
   */
  finalized: boolean("finalized").notNull().default(false),
  /** Backfill jobs that failed (service.ts backfillRun) and the last one's error (name and code): GET stops at 3. */
  finalizeAttempts: integer("finalize_attempts").notNull().default(0),
  finalizeError: text("finalize_error"),
  /**
   * Per business date and side, the source's complete_through read just before that side's intake of the date
   * ({ "2026-11-02": { "a": iso | null, "b": iso | null } }): what the run's items are complete through. Day close (before DEC-064)
   * judges completeness on it, never on the cursor now (records that came after the intake are not items yet).
   */
  seen: jsonb("seen"),
  baselineOf: uuid("baseline_of"),
  /**
   * A rerun asked for by a rollback (POST …/runs/:runId/rollback): the run it rolls back first, with every live run
   * after it, before it runs (rollback.ts). No foreign key: runs go only with their config.
   */
  rollbackOf: uuid("rollback_of"),
  /** When a rollback undid what this run matched and broke, and the rerun that did it (null while it stands). */
  rolledBackAt: timestamp("rolled_back_at", { withTimezone: true }),
  rolledBackBy: uuid("rolled_back_by"),
  /** The job that runs it (pg-boss id; null = run in process): a run whose job is over while it is not is failed (reaper). */
  jobId: uuid("job_id"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [
  unique("recon_runs_space_id_id_key").on(t.spaceId, t.id),
  index("recon_runs_config_started").on(t.spaceId, t.configId, t.startedAt),
  index("recon_runs_baseline").on(t.spaceId, t.baselineOf).where(sql`${t.baselineOf} is not null`),
  foreignKey({ name: "recon_runs_config_fkey", columns: [t.spaceId, t.configId], foreignColumns: [reconConfigs.spaceId, reconConfigs.id] }).onDelete("cascade"),
  check("recon_runs_mode_check", sql`${t.mode} in ('manual', 'tick', 'daily', 'rerun', 'simulation')`),
  foreignKey({ name: "recon_runs_baseline_fkey", columns: [t.spaceId, t.baselineOf], foreignColumns: [t.spaceId, t.id] }).onDelete("cascade"),
  check("recon_runs_status_check", sql`${t.status} in ('queued', 'running', 'succeeded', 'failed')`),
  check("recon_runs_window_check", sql`${t.dateFrom} <= ${t.dateTo}`),
]);

/**
 * A record of a side as one config sees it (spec §8): open → matched | suggested | break (a one-way recon's side B: not_required, DEC-055), then closed. `version` grows
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
  /** The pass that broke it (on_ambiguous break: Duplicate / Ambiguous); null for another break, and for breaks before 0029. */
  breakPass: smallint("break_pass"),
  /**
   * A "No counterpart" break (written at a run's end, DEC-064; grace or day close before): within carry over it stays a candidate of every pass of later
   * runs (DEC-047, Captain: only this reason). False for every other break: a near miss (currency, amount or date
   * differs), a pass's ambiguity (Duplicate), an unconfirmed suggestion with its pair kept.
   */
  lateMatch: boolean("late_match").notNull().default(false),
  /**
   * How a break was resolved; the engine writes only AUTO_MATCHED_LATE_DATA (a break within carry over that an
   * automatic pass paired, DEC-047); the rest is Plan 5's.
   */
  resolution: text("resolution"),
  /**
   * A break within carry over that a suggesting pass of a later run paired (DEC-047): it stays a break, with the item
   * proposed as its pair and that pass, for "Match pair" (Plan 5). Rewritten while the proposal changes.
   */
  proposedItemId: uuid("proposed_item_id"),
  proposedPass: smallint("proposed_pass"),
  /** Where a break stands in its queue (BREAK_STATES; null = new: nobody has it yet). Plan 5. */
  breakState: text("break_state"),
  /** Who works the break (a member of the space); null = Unassigned. */
  assigneeId: uuid("assignee_id"),
  /** When its queue state or assignee last changed. */
  stateAt: timestamp("state_at", { withTimezone: true }),
  version: integer("version").notNull().default(0),
  simRunId: uuid("sim_run_id"),
  /**
   * The run whose pass or end (DEC-064; grace before) last broke it (or made a one-way side-B item not required); null for a day close's, and
   * for breaks before 0077. A rollback of that run puts it back to open (rollback.ts).
   */
  breakRunId: uuid("break_run_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: "recon_items_pkey", columns: [t.spaceId, t.id, t.businessDate] }),
  unique("recon_items_record_key").on(t.spaceId, t.configId, t.recordId, t.businessDate, t.simRunId).nullsNotDistinct(),
  // the pool of a pass: open items of a config's side in a business-date window, live or of one simulation
  index("recon_items_open").on(t.spaceId, t.configId, t.simRunId, t.side, t.businessDate).where(sql`${t.status} = 'open'`),
  index("recon_items_config_date").on(t.spaceId, t.configId, t.businessDate),
  // the breaks for want of a counterpart in the carry-over window, read by every pass beside the open items (DEC-047)
  index("recon_items_late").on(t.spaceId, t.configId, t.simRunId, t.side, t.businessDate).where(sql`${t.status} = 'break' and ${t.lateMatch}`),
  // a one-way recon's not-required side-B items, read by every pass with carry over beside the open items (DEC-055)
  index("recon_items_not_required").on(t.spaceId, t.configId, t.simRunId, t.side, t.businessDate).where(sql`${t.status} = 'not_required'`),
  // the open breaks of a config (Today, Live day: a count per screen read, never a scan of its days)
  index("recon_items_breaks").on(t.spaceId, t.configId).where(sql`${t.status} = 'break' and ${t.simRunId} is null`),
  // the queue of a space's breaks (Plan 5): by assignee, Unassigned first-class
  index("recon_items_break_queue").on(t.spaceId, t.assigneeId, t.businessDate).where(sql`${t.status} = 'break' and ${t.simRunId} is null`),
  // unqualified: a month partition copies the check, and a table-qualified column fails there
  check("recon_items_break_state_check", sql`break_state is null or break_state in ('assigned', 'investigating', 'pending_external', 'proposed_resolution', 'pending_approval', 'resolved')`),
  // a rollback's breaks: the items a run broke that are still its breaks (rollback.ts)
  index("recon_items_break_run").on(t.spaceId, t.configId, t.breakRunId).where(sql`${t.breakRunId} is not null and ${t.status} in ('break', 'not_required')`),
  // a simulation's rows, for the delete of an old simulation (cascade) without a scan of every partition
  index("recon_items_sim_run").on(t.spaceId, t.simRunId).where(sql`${t.simRunId} is not null`),
  foreignKey({ name: "recon_items_config_fkey", columns: [t.spaceId, t.configId], foreignColumns: [reconConfigs.spaceId, reconConfigs.id] }).onDelete("cascade"),
  foreignKey({ name: "recon_items_sim_run_fkey", columns: [t.spaceId, t.simRunId], foreignColumns: [reconRuns.spaceId, reconRuns.id] }).onDelete("cascade"),
  check("recon_items_side_check", sql`${t.side} in ('a', 'b')`),
  check("recon_items_status_check", sql`${t.status} in ('open', 'matched', 'suggested', 'break', 'closed', 'not_required')`),
]);

/**
 * The sign-off of a config's business date (Plan 5 Task 4, spec §11b, DEC-064): no row = open; a reviewer or space admin
 * prepares it (`prepared`), another one signs it (`signed`: not the preparer, nor anyone who resolved an item of that
 * day); signed, the day's items are frozen (day_closed) and out of every pass's pool. There is no day close any more
 * (DEC-064): a run makes what stays unpaired unmatch at once.
 */
export const reconDays = pgTable("recon_days", {
  spaceId: uuid("space_id").notNull(),
  configId: uuid("config_id").notNull(),
  businessDate: date("business_date").notNull(),
  status: text("status").notNull(),
  preparedBy: uuid("prepared_by"),
  preparedAt: timestamp("prepared_at", { withTimezone: true }),
  signedBy: uuid("signed_by"),
  signedAt: timestamp("signed_at", { withTimezone: true }),
}, (t) => [
  primaryKey({ name: "recon_days_pkey", columns: [t.spaceId, t.configId, t.businessDate] }),
  foreignKey({ name: "recon_days_config_fkey", columns: [t.spaceId, t.configId], foreignColumns: [reconConfigs.spaceId, reconConfigs.id] }).onDelete("cascade"),
  check("recon_days_status_check", sql`${t.status} in ('prepared', 'signed')`),
]);

/**
 * How far a live intake of config version `config_version_id` read side `side`'s source for `business_date`: its
 * records up to `seq` (records.seq) were all taken in or passed over, so the next intake reads past it (REC-P1: a tick
 * reads what arrived since, not the whole day). Per version: another version's filters or source start from zero.
 * Never for a snapshot source or a simulation (service.ts intake).
 */
export const reconIntakeMarks = pgTable("recon_intake_marks", {
  spaceId: uuid("space_id").notNull(),
  configVersionId: uuid("config_version_id").notNull(),
  side: text("side").notNull(),
  businessDate: date("business_date").notNull(),
  seq: bigint("seq", { mode: "number" }).notNull(),
}, (t) => [
  primaryKey({ name: "recon_intake_marks_pkey", columns: [t.spaceId, t.configVersionId, t.side, t.businessDate] }),
  foreignKey({ name: "recon_intake_marks_version_fkey", columns: [t.configVersionId], foreignColumns: [reconConfigVersions.id] }).onDelete("cascade"),
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
  /** The run that made it; null for a person's match (kind manual or force, Plan 5), which no run made. */
  runId: uuid("run_id"),
  /** The simulation the group belongs to (its run; null = live), as recon_items.sim_run_id. */
  simRunId: uuid("sim_run_id"),
  passNo: smallint("pass_no").notNull(),
  kind: text("kind").notNull(),
  score: numeric("score"),
  businessDate: date("business_date").notNull(),
  evidence: jsonb("evidence").notNull(),
  /** Who reversed it: the run that found a member's record replaced (reverse_reason source_changed), later an unmatch's user. */
  reversedBy: uuid("reversed_by"),
  /** Why: `source_changed` (a mutable source replaced a member's record, spec §8, REC-FUT-15), `unmatch` (a person, Plan 5), `rolled_back` (a run rolled back: reversed_by = the rerun that did it). */
  reverseReason: text("reverse_reason"),
  reversedAt: timestamp("reversed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("match_groups_space_id_id_key").on(t.spaceId, t.id),
  index("match_groups_config_date").on(t.spaceId, t.configId, t.businessDate),
  // a run's days (service.ts daysOf): groups per date, pass and kind, read from the index alone once vacuum marks the pages
  index("match_groups_days").on(t.spaceId, t.configId, t.simRunId, t.businessDate, t.passNo, t.kind).where(sql`${t.reversedBy} is null`),
  index("match_groups_run").on(t.spaceId, t.runId, t.passNo),
  index("match_groups_sim_run").on(t.spaceId, t.simRunId).where(sql`${t.simRunId} is not null`),
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

/**
 * The recon dashboard's rollup (docs/superpowers/plans/2026-11-24-recon-dashboard.md): one row per live config and
 * business date, recomputed whole from the engine's tables (stats.ts recomputeDayStats), so a missed or repeated job
 * converges. `results` = Operation result rows of the date per overall status, `{ status: [rows, records] }`; `broke` =
 * items of the date that became unmatch; `written_off` = absolute amounts per currency of its items written off;
 * `resolve_minutes` = per resolved item, minutes from its business date's start (Asia/Jakarta) to its resolution.
 */
export const reconDayStats = pgTable("recon_day_stats", {
  spaceId: uuid("space_id").notNull(),
  configId: uuid("config_id").notNull(),
  businessDate: date("business_date").notNull(),
  results: jsonb("results").notNull().default(sql`'{}'::jsonb`),
  broke: integer("broke").notNull().default(0),
  writtenOff: jsonb("written_off").notNull().default(sql`'{}'::jsonb`),
  resolveMinutes: integer("resolve_minutes").array().notNull().default(sql`'{}'::integer[]`),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: "recon_day_stats_pkey", columns: [t.spaceId, t.configId, t.businessDate] }),
  index("recon_day_stats_date").on(t.spaceId, t.businessDate),
  foreignKey({ name: "recon_day_stats_config_fkey", columns: [t.spaceId, t.configId], foreignColumns: [reconConfigs.spaceId, reconConfigs.id] }).onDelete("cascade"),
]);

/**
 * The last freshness alert of a config (spec §9 "Freshness", REC-F4): one stale spell makes one alert, repeated at most
 * hourly, however the schedule's minutes fall (schedule.ts dispatch writes it with a conditional upsert, so two
 * dispatches at once alert once). The alert itself is a log line until an outside channel exists (REC-FUT-10).
 */
export const reconAlerts = pgTable("recon_alerts", {
  spaceId: uuid("space_id").notNull(),
  configId: uuid("config_id").notNull(),
  alertedAt: timestamp("alerted_at", { withTimezone: true }).notNull(),
}, (t) => [
  primaryKey({ name: "recon_alerts_pkey", columns: [t.spaceId, t.configId] }),
  foreignKey({ name: "recon_alerts_config_fkey", columns: [t.spaceId, t.configId], foreignColumns: [reconConfigs.spaceId, reconConfigs.id] }).onDelete("cascade"),
]);
