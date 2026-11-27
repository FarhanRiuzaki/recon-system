// import_file_history in the staging database (import-host's sql/create_import_history.sql + the RERUN migration): a
// Drizzle table object for queries only. It is declared here, not in a schema.ts, on purpose: the table lives in another
// database that import-host created and we never migrate, so drizzle-kit (which reads modules/*/schema.ts) must not see
// it, and recon-system's own database has no such table (boundaries.test.ts rule 3 is about that database).
import { bigint, char, date, integer, pgSchema, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { stagingNames } from "./pool";

const columns = () => ({
  id: uuid("id").primaryKey(),
  source: varchar("source").notNull(),
  fileName: varchar("file_name").notNull(),
  fileDate: date("file_date"),
  fileSize: bigint("file_size", { mode: "number" }).notNull(),
  fileHash: char("file_hash", { length: 64 }).notNull(),
  remotePath: varchar("remote_path"),
  remoteSize: bigint("remote_size", { mode: "number" }),
  remoteMtime: timestamp("remote_mtime", { withTimezone: true }),
  status: varchar("status").notNull(),
  totalRows: integer("total_rows"),
  insertedRows: integer("inserted_rows"),
  duplicateInFile: integer("duplicate_in_file"),
  alreadyInDb: integer("already_in_db"),
  replacedRows: integer("replaced_rows"),
  previousId: uuid("previous_id"),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  downloadedAt: timestamp("downloaded_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

function build(schema: string, name: string) {
  // drizzle refuses pgSchema("public"): a table of the default schema is a plain pgTable
  return schema === "public" ? pgTable(name, columns()) : pgSchema(schema).table(name, columns());
}

let table: ReturnType<typeof build> | undefined;
/** The history table in STAGING_SCHEMA, named STAGING_HISTORY_TABLE. */
export const history = (): ReturnType<typeof build> => (table ??= build(stagingNames().schema, stagingNames().history));
