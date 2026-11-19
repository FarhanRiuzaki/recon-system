// Oracle through oracledb 26.0.0 in Thin mode (no Instant Client; spike S7: transportConnectTimeout works in Bun; no
// server was there to test the rest — REC-F2 go-live gate, docs/recon/README.md). One connection per connector;
// callTimeout caps each round trip; every read runs in a READ ONLY transaction. LOB and RAW values are fetched as text.
import oracledb, { type Connection, type Metadata } from "oracledb";
import type { Column } from "./dialect";
import type { Driver, DriverConfig } from "./index";

const AS_TEXT = [oracledb.DB_TYPE_CLOB, oracledb.DB_TYPE_NCLOB, oracledb.DB_TYPE_RAW];
const OPTIONS = { outFormat: oracledb.OUT_FORMAT_OBJECT, fetchTypeHandler: (m: Metadata) => (AS_TEXT.includes(m.dbType) ? { type: oracledb.STRING } : undefined) };
/** NUMBER with its precision when it has one, so NUMBER(19,0) reads as an integer (dialect.ts). */
const typeOf = (m: Metadata) => (m.dbTypeName === "NUMBER" && m.precision ? `NUMBER(${m.precision},${m.scale ?? 0})` : (m.dbTypeName ?? "VARCHAR2"));

export function oracleDriver(c: DriverConfig): Driver {
  let conn: Promise<Connection> | undefined;
  const open = () => (conn ??= oracledb.getConnection({
    user: c.user, password: c.password, connectString: `${c.tls ? "tcps://" : ""}${c.host}:${c.port}/${c.database}`,
    transportConnectTimeout: c.connectTimeoutSeconds, connectTimeout: c.connectTimeoutSeconds,
  }).then((x) => { x.callTimeout = c.statementTimeoutMs; return x; }));
  /** `fn` inside a read-only transaction, ended after. */
  const readOnly = async <T>(fn: (x: Connection) => Promise<T>): Promise<T> => {
    const x = await open();
    await x.rollback();
    await x.execute("SET TRANSACTION READ ONLY");
    try { return await fn(x); } finally { await x.rollback().catch(() => {}); }
  };
  return {
    rows: (q, params) => readOnly(async (x) => (await x.execute(q, params, OPTIONS)).rows ?? []),
    describe: (q, params) => readOnly(async (x) => ((await x.execute(q, params, OPTIONS)).metaData ?? []).map((m): Column => ({ name: m.name, type: typeOf(m), nullable: m.nullable ?? null }))),
    async *stream(q, params, chunk) {
      const x = await open();
      await x.rollback();
      await x.execute("SET TRANSACTION READ ONLY");
      const rs = (await x.execute(q, params, { ...OPTIONS, resultSet: true })).resultSet!;
      try {
        for (;;) {
          const rows = await rs.getRows(chunk);
          if (!rows.length) return;
          yield rows;
        }
      } finally {
        await rs.close().catch(() => {});
        await x.rollback().catch(() => {});
      }
    },
    async close() {
      const x = await conn?.catch(() => undefined);
      await x?.close().catch(() => {});
    },
  };
}
