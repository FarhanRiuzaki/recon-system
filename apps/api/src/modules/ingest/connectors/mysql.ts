// MySQL / MariaDB through mysql2 3.24.6 (spike S7: connectTimeout works in Bun; no server was there to test the rest).
// One connection per connector: session in UTC (so a TIMESTAMP reads in UTC), read-only, statements capped
// (max_execution_time, MySQL; MariaDB's max_statement_time when that is the one the server knows). Statements are
// server-side prepared (execute), so values are bound, never formatted into the text.
import { type Connection, createConnection, Types } from "mysql2/promise";
import type { Readable } from "node:stream";
import type { Column } from "./dialect";
import type { Driver, DriverConfig } from "./index";
import { batches } from "./index";

export function mysqlDriver(c: DriverConfig): Driver {
  let conn: Promise<Connection> | undefined;
  const open = () => (conn ??= createConnection({
    host: c.host, port: c.port, database: c.database || undefined, user: c.user, password: c.password,
    connectTimeout: c.connectTimeoutSeconds * 1000, ssl: c.tls ? { rejectUnauthorized: true } : undefined,
    supportBigNumbers: true, bigNumberStrings: true, dateStrings: true,
  }).then(async (x) => {
    await x.query("SET SESSION time_zone = '+00:00'");
    await x.query("SET SESSION TRANSACTION READ ONLY");
    const ms = Math.trunc(c.statementTimeoutMs);
    await x.query(`SET SESSION max_execution_time = ${ms}`).catch(() => x.query(`SET SESSION max_statement_time = ${ms / 1000}`));
    return x;
  }));
  const names = Types as unknown as Record<number, string>;
  return {
    async rows(q, params) {
      const [rows] = await (await open()).execute(q, params);
      return rows as Record<string, unknown>[];
    },
    async describe(q, params) {
      const [, fields] = await (await open()).execute(q, params);
      return (fields ?? []).map((f): Column => ({ name: f.name, type: (names[f.columnType ?? f.type ?? -1] ?? "text").toLowerCase(), nullable: null }));
    },
    async *stream(q, params, chunk) {
      // the callback connection under the promise one (mysql2's typings omit the field): its execute() can stream
      const { connection: core } = (await open()) as unknown as { connection: { execute(q: string, p: unknown[]): { stream(o?: { highWaterMark?: number }): Readable } } };
      const s = core.execute(q, params).stream({ highWaterMark: chunk });
      try {
        yield* batches(s, chunk);
      } finally {
        s.destroy();
      }
    },
    // destroy, not end(): end() waits for the statement in flight; a connect still under way is destroyed once it lands
    close: async () => { void conn?.then((x) => x.destroy(), () => {}); },
  };
}
