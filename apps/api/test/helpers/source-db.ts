// A source database for the connector tests: `<test database>_src` on the test cluster, created when missing. It stands
// in for a bank's core DB; the app's own databases are never read as a source.
import { SQL } from "bun";
import { createDatabase } from "../../src/db/migrate";

/** The credential of `<test database>_src` as a source connection stores it (password: any text when the cluster trusts). */
export async function sourceDb(): Promise<{ sql: SQL; secret: { host: string; port: number; database: string; user: string; password: string } }> {
  const u = new URL(process.env.DATABASE_URL!);
  u.pathname = `${u.pathname}_src`;
  await createDatabase(u.href);
  return {
    sql: new SQL(u.href, { max: 2 }),
    secret: { host: u.hostname, port: Number(u.port || 5432), database: u.pathname.slice(1), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) || "unused-trust" },
  };
}
