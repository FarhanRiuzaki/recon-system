// Sources (recon spec §7): kinds, engines, version states and the limits a client form needs. Zod-free for client code.

export const SOURCE_KINDS = ["db_watermark", "db_snapshot", "file_inbox"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];
export const SOURCE_STATUSES = ["active", "paused"] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];
export const DB_ENGINES = ["postgres", "mysql", "mssql", "oracle"] as const;
export type DbEngine = (typeof DB_ENGINES)[number];
/** draft → in_review → published (the one before it retires); a reject sends in_review back to draft. */
export const VERSION_STATUSES = ["draft", "in_review", "published", "retired"] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];
/** A file the inbox picked up: ingested, rejected (same content as one already ingested) or failed (nothing written). */
export const SOURCE_FILE_STATUSES = ["ingested", "rejected", "failed"] as const;
export type SourceFileStatus = (typeof SOURCE_FILE_STATUSES)[number];
/** A snapshot per business date: loading → active (the one before it superseded) or failed (the active one stays). */
export const SNAPSHOT_STATUSES = ["loading", "active", "failed", "superseded"] as const;
export type SnapshotStatus = (typeof SNAPSHOT_STATUSES)[number];
/** Source health for the business date in progress (sourceHealth, apps/api/src/modules/ingest/health.ts). */
export const SOURCE_HEALTH = ["healthy", "degraded", "down"] as const;
export type SourceHealthState = (typeof SOURCE_HEALTH)[number];
export const FIELD_TYPES = ["string", "integer", "decimal", "date", "datetime", "boolean"] as const;
export const FILE_ENCODINGS = ["utf-8", "latin1", "windows-1252", "utf-16le"] as const;

/** A source code: 2–64 of a-z, 0-9, "_" and "-", starting with a letter or digit (sent in any case, stored lower case). */
export const SOURCE_CODE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
export const SOURCE_NAME_MAX = 100;
export const REVIEW_COMMENT_MAX = 1000;
/** The calendar every install has (system seed): Saturday and Sunday off, no holidays. */
export const DEFAULT_CALENDAR = "id-default";
/** A source table as `table` or `schema.table`: identifier characters only (also checked against the source's catalog). */
export const DB_TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_$#]{0,127}(\.[A-Za-z_][A-Za-z0-9_$#]{0,127})?$/;
