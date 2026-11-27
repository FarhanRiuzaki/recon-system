-- The staging database of the tests (`<test database>_staging`, schema __SCHEMA__): import_file_history exactly as
-- import-host created it in recon_engine_import (its sql/create_import_history.sql, RERUN included by
-- sql/migrations/2026-11-18_rerun_status.sql). test/helpers/staging.ts runs it once per test run.
CREATE SCHEMA IF NOT EXISTS __SCHEMA__;

CREATE TABLE IF NOT EXISTS __SCHEMA__.import_file_history (
    id                uuid         NOT NULL DEFAULT uuidv7() PRIMARY KEY,
    source            varchar      NOT NULL,
    file_name         varchar      NOT NULL,
    file_date         date,
    file_size         bigint       NOT NULL,
    file_hash         char(64)     NOT NULL,
    remote_path       varchar,
    remote_size       bigint,
    remote_mtime      timestamptz,
    status            varchar      NOT NULL
                      CHECK (status IN ('PROCESSING', 'IMPORTED', 'FAILED', 'SUPERSEDED', 'RERUN')),
    total_rows        integer,
    inserted_rows     integer,
    duplicate_in_file integer,
    already_in_db     integer,
    replaced_rows     integer,
    previous_id       uuid         REFERENCES __SCHEMA__.import_file_history (id),
    error_message     text,
    started_at        timestamptz  NOT NULL DEFAULT now(),
    finished_at       timestamptz,
    downloaded_at     timestamptz,
    created_at        timestamptz  NOT NULL DEFAULT now(),
    updated_at        timestamptz  NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_import_file_history_processing
    ON __SCHEMA__.import_file_history (source, file_name) WHERE status = 'PROCESSING';
CREATE UNIQUE INDEX IF NOT EXISTS ux_import_file_history_imported
    ON __SCHEMA__.import_file_history (source, file_name) WHERE status = 'IMPORTED';
CREATE INDEX IF NOT EXISTS ix_import_file_history_source_file
    ON __SCHEMA__.import_file_history (source, file_name, created_at DESC);
