// The Import section (DEC-066, docs/superpowers/specs/2026-11-27-import-host-design.md): the names, limits and states a
// form or a screen needs as values, zod-free for client code.

/** A target staging table: `stg_<biller>_host`, lower case words joined by `_`, at most 63 characters (PostgreSQL). */
export const STG_TABLE_NAME = /^(?=.{1,63}$)stg_[a-z0-9]+(_[a-z0-9]+)*_host$/;
/** A target column: a lower case identifier, at most 63 characters. */
export const COLUMN_NAME = /^[a-z][a-z0-9_]{0,62}$/;
/** `import_file_history.source` of a feed, as import-host writes it (`KAI_TLHIST`); never changes once used. */
export const HISTORY_SOURCE = /^[A-Z][A-Z0-9_]{1,62}$/;
/** The batch prefix of `import_file_history.file_name` (`<prefix>:<YYYY-MM-DD>`, import-host: `HISTORY_TLHIST`). */
export const BATCH_PREFIX = /^[A-Z][A-Z0-9_]{1,62}$/;
/** A run or due time, HH:MM in Asia/Jakarta. */
export const RUN_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Column types a target table may have. */
export const COLUMN_TYPES = ["varchar", "char", "numeric", "integer", "bigint", "date", "time", "timestamptz"] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];
/** Columns every target table gets on its own; a feed doesn't list them. */
export const SYSTEM_COLUMNS = ["file_history_id", "uuid", "created_at", "updated_at"] as const;

/** Rows a preview shows. */
export const PREVIEW_ROWS = 50;
/** Dates the monitor shows, the newest last. */
export const MONITOR_DAYS = 14;
/** A scheduled run that hasn't started this many minutes after its time is missed. */
export const START_GRACE_MINUTES = 10;
/** A running run whose heartbeat is older than this is stuck. */
export const HEARTBEAT_STALE_SECONDS = 120;
/** A PROCESSING history row older than this is a lock left behind (import-host's PROCESSING_TIMEOUT_MINUTES). */
export const LOCK_STALE_MINUTES = 60;

/** A feed's MIS date in the monitor. */
export const DATE_STATES = ["waiting", "not_ready", "imported", "late", "missing", "failed", "rerun"] as const;
export type DateState = (typeof DATE_STATES)[number];
/** A feed's scheduler in the monitor. */
export const SCHEDULER_STATES = ["ok", "missed", "stuck", "lock_left", "connection_failing", "off"] as const;
export type SchedulerState = (typeof SCHEDULER_STATES)[number];
/** What one check of a date found. */
export const CHECK_RESULTS = ["not_ready", "imported", "skipped", "failed", "dry_run"] as const;
export type CheckResult = (typeof CHECK_RESULTS)[number];
export const RUN_STATUSES = ["running", "done", "failed", "crashed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
/** `import_file_history.status` (import-host's statuses; RERUN is set by hand or by Rerun). */
export const HISTORY_STATUSES = ["PROCESSING", "IMPORTED", "FAILED", "SUPERSEDED", "RERUN"] as const;
export type HistoryStatus = (typeof HISTORY_STATUSES)[number];

/** `HISTORY_TLHIST.JULIAN_MIS_DATE` of a `YYYY-MM-DD` date: year × 1000 + day of the year (2026-11-03 → 2026307). */
export function julianDate(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return y * 1000 + Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86_400_000) + 1;
}
