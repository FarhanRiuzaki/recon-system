// PostgreSQL through Bun.SQL (spike S7). One connection per connector, its session read-only, in UTC and under the
// statement timeout (startup parameters); a snapshot streams through a server-side cursor inside a read-only
// transaction. Bun.SQL has no query timeout of its own: statement_timeout is the server's (S7).
import { SQL } from "bun";
import type { Column } from "./dialect";
import type { Driver, DriverConfig } from "./index";

export function postgresDriver(c: DriverConfig): Driver {
  const sql = new SQL({
    hostname: c.host, port: c.port, database: c.database, username: c.user, password: c.password, max: 1,
    connectionTimeout: c.connectTimeoutSeconds,
    tls: c.tls ? { rejectUnauthorized: true } : false,
    connection: { statement_timeout: c.statementTimeoutMs, default_transaction_read_only: "on", TimeZone: "UTC", application_name: "recon-connector" },
  });
  return {
    rows: (q, params) => sql.unsafe(q, params) as Promise<Record<string, unknown>[]>,
    async describe(q, params) {
      const r = (await sql.unsafe(q, params)) as unknown as { columns?: { name: string; type: number }[] };
      const cols = r.columns ?? [];
      const types = await sql.unsafe("SELECT oid::int AS oid, format_type(oid, NULL) AS type FROM pg_type WHERE oid = ANY(string_to_array($1, ',')::oid[])", [cols.map((x) => x.type).join(",")]);
      const byOid = new Map((types as { oid: number; type: string }[]).map((x) => [x.oid, x.type]));
      return cols.map((x): Column => ({ name: x.name, type: byOid.get(x.type) ?? "text", nullable: null }));
    },
    async *stream(q, params, chunk) {
      const conn = await sql.reserve();
      try {
        await conn.unsafe("BEGIN");
        await conn.unsafe(`DECLARE recon_cursor NO SCROLL CURSOR FOR ${q}`, params);
        for (;;) {
          const rows = (await conn.unsafe(`FETCH ${chunk} FROM recon_cursor`)) as Record<string, unknown>[];
          if (!rows.length) return;
          yield rows;
        }
      } finally {
        await conn.unsafe("ROLLBACK").catch(() => {});
        conn.release();
      }
    },
    close: () => sql.close({ timeout: 0 }),
  };
}
