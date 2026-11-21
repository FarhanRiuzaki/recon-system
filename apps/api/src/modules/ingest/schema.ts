import { sql } from "drizzle-orm";
import { bigint, check, date, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { jsonb } from "../../kernel/columns";
import { sources } from "../sources/schema";

// The data a source delivers (spec §8): files the inbox picked up, the pull cursor, snapshots per business date, raw
// rows, core records and quarantined lines. Space-owned (space_id in every key and foreign key) under row level
// security (drizzle/0014_ingest_rls.sql). raw_rows and records are partitioned by month of business_date: drizzle-kit
// can't say so, so their CREATE TABLE in drizzle/0013 got `partition by range (business_date)` by hand
// (drizzle/0009 explains); kernel/partitions.ts adds the months. Ids are UUIDv7 made by the app.

/**
 * A file the inbox picked up, once per arrival (name, size and modification time): ingested, rejected (same sha256 as
 * an ingested one) or failed (nothing of it written; `reason` says why). A new content under a known name is the next
 * `version`, pointing at the one before (`version_of`). `business_date` = the date in its name, when it has one.
 */
export const sourceFiles = pgTable("source_files", {
  id: uuid("id").primaryKey(),
  spaceId: uuid("space_id").notNull(),
  sourceId: uuid("source_id").notNull(),
  name: text("name").notNull(),
  sha256: text("sha256").notNull(),
  size: bigint("size", { mode: "number" }).notNull(),
  modifiedAt: timestamp("modified_at", { withTimezone: true, precision: 3 }).notNull(),
  status: text("status").notNull(),
  reason: text("reason"),
  version: integer("version"),
  versionOf: uuid("version_of"),
  businessDate: date("business_date"),
  rowsTotal: integer("rows_total").notNull().default(0),
  rowsOk: integer("rows_ok").notNull().default(0),
  rowsNew: integer("rows_new").notNull().default(0),
  rowsQuarantined: integer("rows_quarantined").notNull().default(0),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique("source_files_space_id_id_key").on(t.spaceId, t.id),
  // one row per arrival: the inbox skips a file it has seen with this name, size and time
  uniqueIndex("source_files_arrival_key").on(t.spaceId, t.sourceId, t.name, t.size, t.modifiedAt),
  // one ingested file per content: the same sha256 again is rejected
  uniqueIndex("source_files_ingested_key").on(t.spaceId, t.sourceId, t.sha256).where(sql`${t.status} = 'ingested'`),
  index("source_files_source_received").on(t.spaceId, t.sourceId, t.receivedAt),
  foreignKey({ name: "source_files_source_fkey", columns: [t.spaceId, t.sourceId], foreignColumns: [sources.spaceId, sources.id] }).onDelete("cascade"),
  check("source_files_status_check", sql`${t.status} in ('ingested', 'rejected', 'failed')`),
]);

/**
 * Where a source's ingest stands: the pull watermark (last row's watermark and id, as the connector wrote them),
 * `complete_through` (data up to here is complete: watermark − lookback, or the end of the last business date with an
 * active snapshot or ingested file), the last success and the last error. `columns` = the source's columns (name and
 * native type) as first pulled under `columns_version_id`; a later pull that finds them changed pauses the source, with
 * the columns that changed in `drift`.
 */
export const sourceCursors = pgTable("source_cursors", {
  spaceId: uuid("space_id").notNull(),
  sourceId: uuid("source_id").notNull(),
  watermark: text("watermark"),
  watermarkId: text("watermark_id"),
  completeThrough: timestamp("complete_through", { withTimezone: true }),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  lastError: text("last_error"),
  columns: jsonb("columns"),
  columnsVersionId: uuid("columns_version_id"),
  /** Why a paused source stopped, per column (rules.ts DriftColumn[]); cleared with last_error. */
  drift: jsonb("drift"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: "source_cursors_pkey", columns: [t.spaceId, t.sourceId] }),
  foreignKey({ name: "source_cursors_source_fkey", columns: [t.spaceId, t.sourceId], foreignColumns: [sources.spaceId, sources.id] }).onDelete("cascade"),
]);

/**
 * One watermark pull (owner, 21 Nov: the source's Pull history): when it ran, how it ended and what it brought. `status`:
 * `new` (records added), `nothing_new`, `failed` (a connection or read error, in `error`), `paused` (the table no longer
 * fits the version). `rows` read, `added` new records, `quarantined` lines, `left_out` by the conditions; `watermark`
 * the position it reached. Each source keeps PULL_DAYS days (pullSource drops older rows of its own source).
 */
export const sourcePulls = pgTable("source_pulls", {
  id: uuid("id").primaryKey(),
  spaceId: uuid("space_id").notNull(),
  sourceId: uuid("source_id").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }).notNull(),
  status: text("status").notNull(),
  rows: integer("rows").notNull().default(0),
  added: integer("added").notNull().default(0),
  quarantined: integer("quarantined").notNull().default(0),
  leftOut: integer("left_out").notNull().default(0),
  watermark: text("watermark"),
  error: text("error"),
}, (t) => [
  index("source_pulls_source_started").on(t.spaceId, t.sourceId, t.startedAt.desc()),
  foreignKey({ name: "source_pulls_source_fkey", columns: [t.spaceId, t.sourceId], foreignColumns: [sources.spaceId, sources.id] }).onDelete("cascade"),
]);

/** A snapshot pull of one business date: at most one loading and one active per date; replaced ones stay, superseded. */
export const sourceSnapshots = pgTable("source_snapshots", {
  id: uuid("id").primaryKey(),
  spaceId: uuid("space_id").notNull(),
  sourceId: uuid("source_id").notNull(),
  businessDate: date("business_date").notNull(),
  status: text("status").notNull(),
  rows: integer("rows").notNull().default(0),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [
  unique("source_snapshots_space_id_id_key").on(t.spaceId, t.id),
  uniqueIndex("source_snapshots_active_key").on(t.spaceId, t.sourceId, t.businessDate).where(sql`${t.status} = 'active'`),
  uniqueIndex("source_snapshots_loading_key").on(t.spaceId, t.sourceId, t.businessDate).where(sql`${t.status} = 'loading'`),
  index("source_snapshots_source_date").on(t.spaceId, t.sourceId, t.businessDate),
  foreignKey({ name: "source_snapshots_source_fkey", columns: [t.spaceId, t.sourceId], foreignColumns: [sources.spaceId, sources.id] }).onDelete("cascade"),
  check("source_snapshots_status_check", sql`${t.status} in ('loading', 'active', 'failed', 'superseded')`),
]);

/**
 * A delivered row as it came (`payload`: column → text, SQL NULL as null), with where it came from: a file (origin_id
 * = source_files.id), a pull run or a snapshot (origin_id = source_snapshots.id, also in snapshot_id). Stored once per
 * (row_hash, business_date) and snapshot: a row pulled again through the lookback or sent again in a file is dropped.
 */
export const rawRows = pgTable("raw_rows", {
  id: uuid("id").notNull(),
  spaceId: uuid("space_id").notNull(),
  sourceId: uuid("source_id").notNull(),
  origin: text("origin").notNull(),
  originId: uuid("origin_id").notNull(),
  snapshotId: uuid("snapshot_id"),
  lineNo: integer("line_no").notNull(),
  payload: jsonb("payload").notNull(),
  rowHash: text("row_hash").notNull(),
  businessDate: date("business_date").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ name: "raw_rows_pkey", columns: [t.spaceId, t.id, t.businessDate] }),
  unique("raw_rows_dedup_key").on(t.spaceId, t.sourceId, t.rowHash, t.businessDate, t.snapshotId).nullsNotDistinct(),
  foreignKey({ name: "raw_rows_source_fkey", columns: [t.spaceId, t.sourceId], foreignColumns: [sources.spaceId, sources.id] }).onDelete("cascade"),
  check("raw_rows_origin_check", sql`${t.origin} in ('file', 'pull', 'snapshot')`),
]);

/**
 * The core record (spec §8) of a raw row, under the source version that mapped it. Immutable sources: once per
 * (row_hash, business_date) and snapshot. Mutable sources: a changed row is a new record and the one it replaces gets
 * `superseded_by`. A snapshot's records count only while that snapshot is active (`currentRecord`, service.ts).
 */
export const records = pgTable("records", {
  id: uuid("id").notNull(),
  spaceId: uuid("space_id").notNull(),
  sourceId: uuid("source_id").notNull(),
  sourceVersionId: uuid("source_version_id").notNull(),
  businessDate: date("business_date").notNull(),
  bdayIndex: integer("bday_index").notNull(),
  extRef: text("ext_ref"),
  accountRef: text("account_ref"),
  amountMinor: bigint("amount_minor", { mode: "bigint" }),
  currency: text("currency"),
  direction: text("direction"),
  eventTime: timestamp("event_time", { withTimezone: true, precision: 3 }),
  attrs: jsonb("attrs").notNull(),
  rowHash: text("row_hash").notNull(),
  naturalKey: text("natural_key"),
  supersededBy: uuid("superseded_by"),
  snapshotId: uuid("snapshot_id"),
  originId: uuid("origin_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /**
   * Insert order (identity, cache 1). A source's records are written only under its sourceLock, held to commit (file,
   * pull page, snapshot switch), so within a source `seq` follows commit order: every record not yet committed has a
   * larger seq than every committed one. The engine's intake reads past the last seq it saw (engine intake marks,
   * REC-P1). Not so for a loading snapshot's rows, written outside the lock and counting only once it is active.
   */
  seq: bigint("seq", { mode: "number" }).notNull().generatedAlwaysAsIdentity(),
}, (t) => [
  primaryKey({ name: "records_pkey", columns: [t.spaceId, t.id, t.businessDate] }),
  unique("records_dedup_key").on(t.spaceId, t.sourceId, t.rowHash, t.businessDate, t.snapshotId).nullsNotDistinct(),
  index("records_source_seq").on(t.spaceId, t.sourceId, t.businessDate, t.seq),
  index("records_current_key").on(t.spaceId, t.sourceId, t.naturalKey).where(sql`${t.supersededBy} is null`),
  // Records tab (owner, 21 Nov): find a record by the start of its reference or account (LIKE 'x%' uses these)
  index("records_source_ext_ref").on(t.spaceId, t.sourceId, t.extRef.op("text_pattern_ops")),
  index("records_source_account_ref").on(t.spaceId, t.sourceId, t.accountRef.op("text_pattern_ops")),
  foreignKey({ name: "records_source_fkey", columns: [t.spaceId, t.sourceId], foreignColumns: [sources.spaceId, sources.id] }).onDelete("cascade"),
]);

/**
 * A line that could not become a record, with a reason per column (`_row` for the whole line); never fails its job.
 * A file's or snapshot's line is kept once per line (origin_id, line_no), so a file's rows_quarantined is the lines
 * shown. A pulled line is kept once per raw_hash (SHA-256 of its text): a pull reads its lookback again on every run,
 * and the same bad row would otherwise come back each minute. A pulled line has no business date (it counts on the
 * day it arrived), so the pull key leaves business_date out.
 */
export const quarantineRows = pgTable("quarantine_rows", {
  id: uuid("id").primaryKey(),
  spaceId: uuid("space_id").notNull(),
  sourceId: uuid("source_id").notNull(),
  origin: text("origin").notNull(),
  originId: uuid("origin_id").notNull(),
  lineNo: integer("line_no").notNull(),
  raw: text("raw").notNull(),
  rawHash: text("raw_hash").notNull(),
  reasons: jsonb("reasons").notNull(),
  businessDate: date("business_date"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("quarantine_rows_source_created").on(t.spaceId, t.sourceId, t.createdAt),
  uniqueIndex("quarantine_rows_pull_key").on(t.spaceId, t.sourceId, t.rawHash).where(sql`${t.origin} = 'pull'`),
  uniqueIndex("quarantine_rows_line_key").on(t.spaceId, t.sourceId, t.origin, t.originId, t.lineNo).where(sql`${t.origin} <> 'pull'`),
  foreignKey({ name: "quarantine_rows_source_fkey", columns: [t.spaceId, t.sourceId], foreignColumns: [sources.spaceId, sources.id] }).onDelete("cascade"),
  check("quarantine_rows_origin_check", sql`${t.origin} in ('file', 'pull', 'snapshot')`),
]);

/**
 * Records today and quarantined today as counters (the sources list read a count(*) over the day's records: 4.7 s for
 * a page of 15 sources of 1M records each, past the 5 s statement timeout): per source, business date and `kind`
 * (`records` = its current records, `quarantined` = its quarantined lines, a pulled line on the Asia/Jakarta date it
 * arrived), written only by the ingest transaction that changes what it counts (service.ts `tally`):
 * - a file or a pull adds the records it added, by date; a mutable source's supersede subtracts those it replaced;
 * - a snapshot's records count only while it is active, and a snapshot source has no other records, so the
 *   transaction that makes a snapshot active sets the date's count to that snapshot's records (nothing to subtract);
 * - a quarantined line adds when it is inserted, whatever becomes of its snapshot (as quarantine_rows counts it).
 * A space a source is shared to reads its `records` counters only (drizzle/0019); quarantine stays the owner's.
 */
export const sourceDayCounts = pgTable("source_day_counts", {
  spaceId: uuid("space_id").notNull(),
  sourceId: uuid("source_id").notNull(),
  businessDate: date("business_date").notNull(),
  kind: text("kind").notNull(),
  n: integer("n").notNull(),
}, (t) => [
  primaryKey({ name: "source_day_counts_pkey", columns: [t.spaceId, t.sourceId, t.businessDate, t.kind] }),
  foreignKey({ name: "source_day_counts_source_fkey", columns: [t.spaceId, t.sourceId], foreignColumns: [sources.spaceId, sources.id] }).onDelete("cascade"),
  check("source_day_counts_kind_check", sql`${t.kind} in ('records', 'quarantined')`),
]);
