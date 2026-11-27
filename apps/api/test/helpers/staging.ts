// The staging database of the tests: `<test database>_staging` on the test cluster, schema `imports_staging`, with
// import-host's import_file_history (test/fixtures/staging.sql). The preload points STAGING_* at it; nothing here ever
// reaches the real recon_engine_import.
import { SQL } from "bun";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createDatabase } from "../../src/db/migrate";

export const STAGING_SCHEMA = "imports_staging";

/** Creates the staging database when missing and its history table (idempotent). */
export async function prepareStaging(url: string): Promise<void> {
  await createDatabase(url);
  const sql = new SQL(url, { max: 1 });
  try {
    await sql.unsafe(readFileSync(path.join(import.meta.dir, "../fixtures/staging.sql"), "utf8").replaceAll("__SCHEMA__", STAGING_SCHEMA));
  } finally {
    await sql.close();
  }
}

let raw: SQL | undefined;
/** A raw connection to the test staging database, for arranging and reading rows as import-host would. */
export const stagingSql = (): SQL => (raw ??= new SQL(process.env.STAGING_DATABASE_URL!, { max: 2 }));

/** Empties the history and drops every stg_* table of the test schema. */
export async function resetStaging(): Promise<void> {
  const s = stagingSql();
  const tables: { t: string }[] = await s`select tablename as t from pg_tables where schemaname = ${STAGING_SCHEMA} and tablename like 'stg\\_%'`;
  for (const { t } of tables) await s.unsafe(`drop table "${STAGING_SCHEMA}"."${t}"`);
  await s.unsafe(`truncate table "${STAGING_SCHEMA}".import_file_history`);
}

export type HistoryRow = {
  source: string; date: string; status: "PROCESSING" | "IMPORTED" | "FAILED" | "SUPERSEDED" | "RERUN";
  prefix?: string; rows?: number; inserted?: number; error?: string; createdAt?: string; finishedAt?: string | null; updatedAt?: string;
};

/** Inserts one history row as import-host writes it (`file_name` = `<prefix>:<date>`); answers its id. */
export async function historyRow(r: HistoryRow): Promise<string> {
  const created = r.createdAt ?? new Date().toISOString();
  const finished = r.finishedAt === undefined ? (r.status === "PROCESSING" ? null : created) : r.finishedAt;
  const [row] = await stagingSql()`
    insert into ${stagingSql()(STAGING_SCHEMA)}.import_file_history
      (source, file_name, file_date, file_size, file_hash, status, total_rows, inserted_rows, error_message,
       started_at, finished_at, created_at, updated_at)
    values (${r.source}, ${`${r.prefix ?? "HISTORY_TLHIST"}:${r.date}`}, ${r.date}, ${r.rows ?? 0}, ${"0".repeat(64)}, ${r.status},
       ${r.rows ?? null}, ${r.inserted ?? null}, ${r.error ?? null}, ${created}, ${finished}, ${created}, ${r.updatedAt ?? created})
    returning id`;
  return row.id as string;
}
