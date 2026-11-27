// `bun test` preload: points the API at the test database, creates it when missing and migrates it once.
// Bun loads apps/api/.env first, so every value that could reach the dev database is overwritten here.
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stagingUrl } from "./staging-url";
import { testDatabaseUrl } from "./test-url";

const url = testDatabaseUrl(process.env);
/** The file inbox root of the tests (INBOX_ROOTS): a folder of its own under the OS temp folder. */
const inbox = path.join(tmpdir(), "recon-test-inbox");
mkdirSync(inbox, { recursive: true });
Object.assign(process.env, {
  NODE_ENV: "test",
  DATABASE_URL: url,
  MIGRATION_DATABASE_URL: url,
  INTERNAL_API_TOKEN: "test-internal-token-0123456789abcdef",
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 42).toString("base64"),
  OAUTH_MOCK: "true",
  LDAP_MOCK: "true",
  MAIL_TRANSPORT: "log",
  LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "silent",
  INBOX_ROOTS: inbox,
  // The Import section's staging database: <test database>_staging, schema imports_staging (test/helpers/staging.ts).
  STAGING_DATABASE_URL: stagingUrl(url),
  STAGING_SCHEMA: "imports_staging",
  STAGING_HISTORY_TABLE: "import_file_history",
  STAGING_READONLY_ROLE: "",
});

// After the env above: the logger reads LOG_LEVEL when it loads.
const { createDatabase, migrate, migrateJobs } = await import("../../src/db/migrate");
await createDatabase(url);
await migrate();
await migrateJobs();
const { prepareStaging } = await import("./staging");
await prepareStaging(process.env.STAGING_DATABASE_URL!);

export {};
