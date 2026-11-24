// `bun src/db/seed/cli.ts system | demo | reset | local` (root scripts db:seed, db:seed:demo, db:reset). Logs steps, never a value.
// Needs only MIGRATION_DATABASE_URL/DATABASE_URL (and SEED_SUPERADMIN_*), not the server's secrets: kernel/db.ts reads
// just the pool keys when it loads (`loadDbConfig`).
import { drizzle } from "drizzle-orm/bun-sql";
import { client } from "../../kernel/db";
import { closeJobs } from "../../kernel/jobs";
import { log } from "../../kernel/log";
import { migrateJobs, migrationSql, resetSchema } from "../migrate";
import { seedDemo } from "./demo";
import { seedDemoRecon } from "./demo-recon";
import { seedLocal } from "./local";
import { seedSystem } from "./system";

const cmd = process.argv[2];
if (cmd !== "system" && cmd !== "demo" && cmd !== "reset" && cmd !== "local") throw new Error("Usage: bun src/db/seed/cli.ts system | demo | reset | local");
if (cmd === "reset" && process.env.NODE_ENV === "production") throw new Error("db:reset is refused when NODE_ENV=production.");

const raw = migrationSql();
const db = drizzle({ client: raw });
try {
  if (cmd === "reset") {
    await resetSchema(raw);
    await migrateJobs(); // pg-boss's schema too, as db:migrate does: without it a run (POST …/run) answers 500
    log.info("schema dropped and migrated");
  }
  if (cmd === "local") {
    await seedSystem(db, process.env);
    await seedLocal(db, process.env);
    log.info("local seed done (space Treasury)");
  } else if (cmd !== "demo") {
    await seedSystem(db, process.env);
    log.info("system seed done");
  }
  if (cmd === "demo" || cmd === "reset") {
    await seedDemo(db);
    // db:seed:demo only: the E2E's db:reset keeps the data its specs count
    if (cmd === "demo") await seedDemoRecon(db);
    log.info("demo seed done");
  }
} finally {
  await raw.close();
  // the demo recons' runs queue the dashboard's rollup (pg-boss) and work breaks on the app pool: both closed, so the
  // one-shot process exits
  await closeJobs();
  await client.close();
}
