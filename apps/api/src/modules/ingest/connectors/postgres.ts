// PostgreSQL through Bun.SQL (spike S7). One connection per connector. Every statement runs in its own
// `BEGIN READ ONLY; SET LOCAL statement_timeout …; <statement>; ROLLBACK` on that connection: IT's SELECT can call
// set_config() on the session, but a read-only transaction can't be made read-write, and whatever it set is rolled
// back with the transaction, so the next statement starts read-only and timed again. A snapshot streams through a
// server-side cursor inside such a transaction. Bun.SQL has no query timeout of its own: statement_timeout is the
// server's (S7). The startup parameters only set the same defaults; the transaction is what holds.
import { type ReservedSQL, SQL } from "bun";
import type { Column } from "./dialect";
import type { Driver, DriverConfig } from "./index";

export function postgresDriver(c: DriverConfig): Driver {
  const sql = new SQL({
    hostname: c.host, port: c.port, database: c.database, username: c.user, password: c.password, max: 1,
    connectionTimeout: c.connectTimeoutSeconds,
    tls: c.tls ? { rejectUnauthorized: true } : false,
    connection: { statement_timeout: c.statementTimeoutMs, default_transaction_read_only: "on", TimeZone: "UTC", application_name: "recon-connector" },
  });
  const timeout = Math.trunc(c.statementTimeoutMs);
  /** `fn` on the reserved connection inside a read-only transaction with the statement timeout, rolled back after. */
  async function* readOnly<T>(fn: (conn: ReservedSQL) => AsyncGenerator<T>): AsyncGenerator<T> {
    const conn = await sql.reserve();
    try {
      await conn.unsafe("BEGIN READ ONLY");
      await conn.unsafe(`SET LOCAL statement_timeout = ${timeout}`);
      yield* fn(conn);
    } finally {
      await conn.unsafe("ROLLBACK").catch(() => {});
      conn.release();
    }
  }
  const once = async <T>(fn: (conn: ReservedSQL) => Promise<T>): Promise<T> => {
    for await (const v of readOnly(async function* (conn) { yield await fn(conn); })) return v;
    throw new Error("unreachable");
  };
  return {
    rows: (q, params) => once((conn) => conn.unsafe(q, params) as Promise<Record<string, unknown>[]>),
    // The columns of `q` (describeSql: it returns no row) read through SQL, not the driver's result metadata: Bun.SQL
    // 1.4.3 (the pinned runtime) answers no `columns` at all, so a query described as zero columns (owner, 21 Nov).
    // `q` LEFT JOINed to one row gives a row of NULLs: its JSON object names every column in order, a name used twice
    // twice (introspect refuses that), a numeric name too; pg_typeof over the same row gives each type, read as an
    // array (no object keys to reorder).
    describe: (q, params) => once(async (conn) => {
      const shell = `(SELECT q.* FROM (SELECT 1) one LEFT JOIN (${q}) q ON true) r`;
      const names = ((await conn.unsafe(`SELECT k.name FROM (SELECT to_json(r) AS j FROM ${shell}) x, json_object_keys(x.j) WITH ORDINALITY AS k(name, n) ORDER BY k.n`,
        params)) as { name: string }[]).map((x) => x.name);
      if (!names.length || new Set(names).size !== names.length) return names.map((name): Column => ({ name, type: "unknown", nullable: null }));
      const typeOf = names.map((n) => `pg_typeof(r."${n.replaceAll('"', '""')}")::text`).join(", ");
      const [types] = (await conn.unsafe(`SELECT ${typeOf} FROM ${shell}`, params).values()) as string[][];
      return names.map((name, i): Column => ({ name, type: types?.[i] ?? "text", nullable: null }));
    }),
    stream: (q, params, chunk) => readOnly(async function* (conn) {
      await conn.unsafe(`DECLARE recon_cursor NO SCROLL CURSOR FOR ${q}`, params);
      for (;;) {
        const rows = (await conn.unsafe(`FETCH ${chunk} FROM recon_cursor`)) as Record<string, unknown>[];
        if (!rows.length) return;
        yield rows;
      }
    }),
    close: () => sql.close({ timeout: 0 }),
  };
}
