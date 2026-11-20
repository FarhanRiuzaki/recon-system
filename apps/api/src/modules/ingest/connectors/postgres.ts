// PostgreSQL through Bun.SQL (spike S7). One connection per connector. Every statement runs in its own
// `BEGIN READ ONLY; SET LOCAL statement_timeout …; <statement>; ROLLBACK` on that connection: IT's SELECT can call
// set_config() on the session, but a read-only transaction can't be made read-write, and whatever it set is rolled
// back with the transaction, so the next statement starts read-only and timed again. A snapshot streams through a
// server-side cursor inside such a transaction. Bun.SQL has no query timeout of its own: statement_timeout is the
// server's (S7). The startup parameters only set the same defaults; the transaction is what holds.
import { type ReservedSQL, SQL } from "bun";
import type { Column } from "./dialect";
import type { Driver, DriverConfig } from "./index";

// A connect that stalls is retried once on a fresh pool: through Docker Desktop's host.docker.internal the dev stack saw
// 8006 ms and 5248 ms stalls on two concurrent tests ending together (api log 2026-11-21), while 300+ cold connects
// run from the container took 6-43 ms. So each attempt gets 40 % of the connect budget (two attempts leave room for
// the statements inside the caller's deadline) and only a connect timeout is retried, never a refusal or a login.
const CONNECT_ATTEMPTS = 2;
const ATTEMPT_SHARE = 0.4;

export function postgresDriver(c: DriverConfig): Driver {
  const attemptSeconds = Math.max(1, Math.floor(c.connectTimeoutSeconds * ATTEMPT_SHARE));
  const open = () => new SQL({
    hostname: c.host, port: c.port, database: c.database, username: c.user, password: c.password, max: 1,
    connectionTimeout: attemptSeconds,
    tls: c.tls ? { rejectUnauthorized: true } : false,
    connection: { statement_timeout: c.statementTimeoutMs, default_transaction_read_only: "on", TimeZone: "UTC", application_name: "recon-connector" },
  });
  let sql = open();
  /** A connection from the pool; a connect timeout is retried on a fresh pool. */
  async function reserve(): Promise<ReservedSQL> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await sql.reserve();
      } catch (e) {
        if ((e as { code?: unknown }).code !== "ERR_POSTGRES_CONNECTION_TIMEOUT" || attempt >= CONNECT_ATTEMPTS) throw e;
        const stale = sql;
        sql = open();
        void stale.close({ timeout: 0 }).catch(() => {});
      }
    }
  }
  const timeout = Math.trunc(c.statementTimeoutMs);
  /** `fn` on the reserved connection inside a read-only transaction with the statement timeout, rolled back after. */
  async function* readOnly<T>(fn: (conn: ReservedSQL) => AsyncGenerator<T>): AsyncGenerator<T> {
    const conn = await reserve();
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
    describe: (q, params) => once(async (conn) => {
      const r = (await conn.unsafe(q, params)) as unknown as { columns?: { name: string; type: number }[] };
      const cols = r.columns ?? [];
      const types = await conn.unsafe("SELECT oid::int AS oid, format_type(oid, NULL) AS type FROM pg_type WHERE oid = ANY(string_to_array($1, ',')::oid[])", [cols.map((x) => x.type).join(",")]);
      const byOid = new Map((types as { oid: number; type: string }[]).map((x) => [x.oid, x.type]));
      return cols.map((x): Column => ({ name: x.name, type: byOid.get(x.type) ?? "text", nullable: null }));
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
