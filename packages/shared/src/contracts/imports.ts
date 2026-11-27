import { z } from "zod";
import {
  BATCH_PREFIX, CHECK_RESULTS, COLUMN_NAME, COLUMN_TYPES, DATE_STATES, HISTORY_SOURCE, HISTORY_STATUSES, RUN_STATUSES, RUN_TIME,
  SCHEDULER_STATES, STG_TABLE_NAME,
} from "../imports";
import { IMPORT_CHECK_SORTS, IMPORT_FEED_SORTS, IMPORT_HISTORY_SORTS, IMPORT_RUN_SORTS } from "../paging";
import { ListQuery, sortParam } from "./common";

export { IMPORT_CHECK_SORTS, IMPORT_FEED_SORTS, IMPORT_HISTORY_SORTS, IMPORT_RUN_SORTS };

const realDate = (d: string) => { const t = Date.parse(`${d}T00:00:00Z`); return !Number.isNaN(t) && new Date(t).toISOString().startsWith(d); };
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(realDate, "Not a real date");
const runTime = z.string().regex(RUN_TIME, "Use HH:MM, 24-hour.");
/** A column of the DWH query's result (as the query names it). */
const sourceColumn = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/);

export const ImportDateState = z.enum(DATE_STATES);
export const ImportSchedulerState = z.enum(SCHEDULER_STATES);
export const ImportCheckResult = z.enum(CHECK_RESULTS);
export const ImportRunStatus = z.enum(RUN_STATUSES);
export const ImportHistoryStatus = z.enum(HISTORY_STATUSES);
export const ImportTrigger = z.enum(["schedule", "manual"]);

/** One column of a target table (the system columns are added on their own). */
export const ImportColumn = z.strictObject({
  name: z.string().regex(COLUMN_NAME),
  type: z.enum(COLUMN_TYPES),
  /** varchar / char length; varchar without one is unbounded. */
  length: z.number().int().min(1).max(10_485_760).optional(),
  precision: z.number().int().min(1).max(38).optional(),
  scale: z.number().int().min(0).max(38).optional(),
  required: z.boolean(),
  /** The only values the column takes (a CHECK constraint), e.g. D and C. */
  allowed: z.array(z.string().min(1).max(100)).min(1).max(50).optional(),
});
export type ImportColumn = z.infer<typeof ImportColumn>;

export const ImportTable = z.strictObject({
  name: z.string().regex(STG_TABLE_NAME),
  columns: z.array(ImportColumn).min(1).max(200),
  /** The dedupe key, also the table's unique index ux_<name>_dedupe; `normalize` = compared as upper(btrim(column)). */
  dedupe: z.array(z.strictObject({ column: z.string().regex(COLUMN_NAME), normalize: z.boolean() })).min(1).max(8),
});
export type ImportTable = z.infer<typeof ImportTable>;

/** Per value of the code column: where the row came from, its transaction type ("" = take it from the row) and whether its mapping was checked. */
export const ImportCodeRules = z.strictObject({
  column: sourceColumn,
  rules: z.array(z.strictObject({
    code: z.string().min(1).max(40),
    sourceType: z.string().max(40),
    transactionType: z.string().max(100),
    verified: z.boolean(),
  })).max(200),
});
export type ImportCodeRules = z.infer<typeof ImportCodeRules>;

/**
 * A feed's settings (spec §4–§6). Everything after `due` may be missing while the scheduler is off (the monitor needs
 * only the history source, prefix, start date and due); turning the scheduler on needs all of it.
 */
export const ImportFeedSpec = z.strictObject({
  kind: z.literal("db_host"),
  historySource: z.string().regex(HISTORY_SOURCE),
  batchPrefix: z.string().regex(BATCH_PREFIX),
  startDate: isoDate,
  /** MIS date D is due on D + 1 at `time`, plus `graceMinutes`. */
  due: z.strictObject({ time: runTime, graceMinutes: z.number().int().min(0).max(720) }),
  connectionId: z.uuid().optional(),
  /** One SELECT for one MIS date, with :julian_mis_date and/or :mis_date. */
  query: z.string().min(1).max(20_000).optional(),
  /** Any row = the source is loaded for that date. */
  readinessQuery: z.string().min(1).max(20_000).optional(),
  table: ImportTable.optional(),
  /** Each target column from a CEL expression over `row`, `code` and `out` (the columns before it); "" = NULL. */
  mapping: z.array(z.strictObject({ column: z.string().regex(COLUMN_NAME), expr: z.string().max(1000) })).max(200).optional(),
  codeRules: ImportCodeRules.nullable().optional(),
  /** Run times; a run longer than `maxMinutes` is stuck. */
  schedule: z.strictObject({ times: z.array(runTime).min(1).max(24), maxMinutes: z.number().int().min(5).max(240) }).optional(),
  /** host: an IMPORTED date is final until a Rerun. */
  revision: z.literal("none").optional(),
});
export type ImportFeedSpec = z.infer<typeof ImportFeedSpec>;

export const ImportFeedBody = z.strictObject({ name: z.string().trim().min(1).max(100), spec: ImportFeedSpec });
export type ImportFeedBody = z.infer<typeof ImportFeedBody>;

export const ImportTableState = z.enum(["missing", "created", "adopted"]);

export const ImportFeedDto = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.literal("db_host"),
  spec: ImportFeedSpec,
  schedulerOn: z.boolean(),
  tableState: ImportTableState,
  /** What still keeps the scheduler from going on, as sentences; empty = complete. */
  missing: z.array(z.string()),
  updatedAt: z.string(),
});
export type ImportFeedDto = z.infer<typeof ImportFeedDto>;

export const ImportFeedRowDto = z.object({
  id: z.string(),
  name: z.string(),
  historySource: z.string(),
  table: z.string().nullable(),
  schedulerOn: z.boolean(),
  runTimes: z.array(z.string()),
  complete: z.boolean(),
  updatedAt: z.string(),
});
export type ImportFeedRowDto = z.infer<typeof ImportFeedRowDto>;

export const ImportFeedListQuery = ListQuery.extend({ sort: sortParam(IMPORT_FEED_SORTS) });
export type ImportFeedListQuery = z.infer<typeof ImportFeedListQuery>;

/** One execution of a feed's job (also when it found no date to do). */
export const ImportRunDto = z.object({
  id: z.string(),
  feedId: z.string(),
  trigger: ImportTrigger,
  /** The run time it was scheduled for; null for a manual run. */
  scheduledFor: z.string().nullable(),
  startedAt: z.string(),
  heartbeatAt: z.string(),
  finishedAt: z.string().nullable(),
  status: ImportRunStatus,
  dates: z.number().int(),
  message: z.string().nullable(),
  by: z.object({ id: z.string(), name: z.string() }).nullable(),
});
export type ImportRunDto = z.infer<typeof ImportRunDto>;

/** One look at one MIS date of a feed. */
export const ImportCheckDto = z.object({
  id: z.string(),
  date: z.string(),
  at: z.string(),
  trigger: ImportTrigger,
  result: ImportCheckResult,
  rows: z.number().int().nullable(),
  inserted: z.number().int().nullable(),
  replaced: z.number().int().nullable(),
  historyId: z.string().nullable(),
  message: z.string().nullable(),
  by: z.object({ id: z.string(), name: z.string() }).nullable(),
});
export type ImportCheckDto = z.infer<typeof ImportCheckDto>;

/** One row of import_file_history (staging), whoever wrote it (this engine or import-host). */
export const ImportHistoryDto = z.object({
  id: z.string(),
  fileName: z.string(),
  fileDate: z.string().nullable(),
  status: ImportHistoryStatus,
  fileSize: z.number().int(),
  fileHash: z.string(),
  totalRows: z.number().int().nullable(),
  insertedRows: z.number().int().nullable(),
  duplicateInFile: z.number().int().nullable(),
  alreadyInDb: z.number().int().nullable(),
  replacedRows: z.number().int().nullable(),
  previousId: z.string().nullable(),
  errorMessage: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ImportHistoryDto = z.infer<typeof ImportHistoryDto>;

export const ImportRunListQuery = ListQuery.extend({ sort: sortParam(IMPORT_RUN_SORTS), status: ImportRunStatus.optional() });
export type ImportRunListQuery = z.infer<typeof ImportRunListQuery>;
export const ImportCheckListQuery = ListQuery.extend({ sort: sortParam(IMPORT_CHECK_SORTS), date: isoDate.optional() });
export type ImportCheckListQuery = z.infer<typeof ImportCheckListQuery>;
export const ImportHistoryListQuery = ListQuery.extend({ sort: sortParam(IMPORT_HISTORY_SORTS), date: isoDate.optional(), status: ImportHistoryStatus.optional() });
export type ImportHistoryListQuery = z.infer<typeof ImportHistoryListQuery>;

/** GET /api/imports/monitor: the MONITOR_DAYS dates ending at `to` (default yesterday, Asia/Jakarta). */
export const ImportMonitorQuery = z.object({ to: isoDate.optional() });
export type ImportMonitorQuery = z.infer<typeof ImportMonitorQuery>;

export const ImportCellDto = z.object({
  date: z.string(),
  state: ImportDateState,
  /** Rows of the IMPORTED version; null when none. */
  rows: z.number().int().nullable(),
  /** When it was imported, or the last check. */
  at: z.string().nullable(),
  message: z.string().nullable(),
});
export type ImportCellDto = z.infer<typeof ImportCellDto>;

export const ImportSchedulerDto = z.object({
  state: ImportSchedulerState,
  lastRun: ImportRunDto.nullable(),
  nextRun: z.string().nullable(),
  message: z.string().nullable(),
});
export type ImportSchedulerDto = z.infer<typeof ImportSchedulerDto>;

export const ImportMonitorDto = z.object({
  now: z.string(),
  workerAlive: z.boolean(),
  dates: z.array(z.string()),
  /** Today's cells (the newest date) by state, over every feed. */
  today: z.record(ImportDateState, z.number().int()),
  feeds: z.array(z.object({
    id: z.string(),
    name: z.string(),
    schedulerOn: z.boolean(),
    scheduler: ImportSchedulerDto,
    cells: z.array(ImportCellDto),
  })),
});
export type ImportMonitorDto = z.infer<typeof ImportMonitorDto>;

/** GET /api/imports/issues: the Monitoring badge. */
export const ImportIssuesDto = z.object({ count: z.number().int() });
export type ImportIssuesDto = z.infer<typeof ImportIssuesDto>;

/** GET /api/imports/feeds/{feedId}/dates/{date}: one cell opened. */
export const ImportDateDto = z.object({
  date: z.string(),
  state: ImportDateState,
  checks: z.array(ImportCheckDto),
  versions: z.array(ImportHistoryDto),
});
export type ImportDateDto = z.infer<typeof ImportDateDto>;
