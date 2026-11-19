// SQL Server through mssql 12.7.15 on tedious (spike S7: connectionTimeout works in Bun; no server was there to test
// the rest). One pooled connection per connector; requestTimeout caps each statement. SQL Server has no read-only
// session or transaction: the account should be read-only (spec §7), and only one checked SELECT is ever sent.
import { ConnectionPool, type Request } from "mssql";
import type { Column } from "./dialect";
import type { Driver, DriverConfig } from "./index";
import { batches } from "./index";

export function mssqlDriver(c: DriverConfig): Driver {
  const pool = new ConnectionPool({
    server: c.host, port: c.port, database: c.database, user: c.user, password: c.password,
    connectionTimeout: c.connectTimeoutSeconds * 1000, requestTimeout: c.statementTimeoutMs,
    options: { encrypt: c.tls, trustServerCertificate: false, useUTC: true }, pool: { max: 1, min: 0 },
  });
  let ready: Promise<ConnectionPool> | undefined;
  const request = async (params: (string | null)[]): Promise<Request> => {
    const r = (await (ready ??= pool.connect())).request();
    params.forEach((v, i) => r.input(`p${i}`, v));
    return r;
  };
  return {
    rows: async (q, params) => (await (await request(params)).query(q)).recordset,
    async describe(q, params) {
      const { recordset } = await (await request(params)).query(q);
      return Object.values(recordset.columns).map((x): Column => ({ name: x.name, type: x.type.declaration ?? "nvarchar", nullable: x.nullable ?? null }));
    },
    async *stream(q, params, chunk) {
      const r = await request(params);
      const s = r.toReadableStream({ highWaterMark: chunk });
      void r.query(q).catch(() => {}); // the stream carries the error
      try {
        yield* batches(s, chunk);
      } finally {
        s.destroy();
      }
    },
    close: () => pool.close().catch(() => {}),
  };
}
