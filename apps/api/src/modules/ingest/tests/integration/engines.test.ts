// MySQL, SQL Server and Oracle connectors against a real server: run only when TEST_MYSQL_URL / TEST_MSSQL_URL /
// TEST_ORACLE_URL is set (engine://user:password@host:port/database; Oracle: the service name as the database),
// otherwise skipped with a message. The user needs CREATE TABLE in its default schema. Oracle stays the REC-F2
// go-live gate (docs/recon/README.md): a real Oracle server must pass this file before KSEI goes live.
import { describe, expect, it } from "bun:test";
import type { DbEngine } from "@starterkit/shared/sources";
import { ConnectionPool } from "mssql";
import { createConnection } from "mysql2/promise";
import oracledb from "oracledb";
import { type Connector, connectorFor, type Row, type Secret } from "../../connectors";

const ENGINES: [DbEngine, string, string][] = [["mysql", "TEST_MYSQL_URL", "3306"], ["mssql", "TEST_MSSQL_URL", "1433"], ["oracle", "TEST_ORACLE_URL", "1521"]];

const secretOf = (url: string, port: string): Secret => {
  const u = new URL(url);
  return { host: u.hostname, port: Number(u.port || port), database: decodeURIComponent(u.pathname.slice(1)), user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) };
};
const all = async (it: AsyncIterable<Row[]>) => { const out: Row[] = []; for await (const p of it) out.push(...p); return out; };

/** Setup DDL per engine (run through the driver directly: the connector's session is read-only). */
const SETUP: Record<Exclude<DbEngine, "postgres">, { table: string; wm: string; id: string; ddl: string[] }> = {
  mysql: { table: "recon_ties", wm: "updated_at", id: "id", ddl: [
    "DROP TABLE IF EXISTS recon_ties",
    "CREATE TABLE recon_ties (id BIGINT PRIMARY KEY, updated_at DATETIME(6) NOT NULL, ref VARCHAR(20) NOT NULL, note VARCHAR(20) NULL)",
    "INSERT INTO recon_ties SELECT n, TIMESTAMPADD(MICROSECOND, FLOOR((n - 1) / 7) * 37, '2026-11-19 00:00:00'), CONCAT('R', n), CASE n % 3 WHEN 0 THEN NULL WHEN 1 THEN '' ELSE CONCAT('n', n) END "
      + "FROM (WITH RECURSIVE s(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM s WHERE n < 70) SELECT n FROM s) x",
  ] },
  mssql: { table: "recon_ties", wm: "updated_at", id: "id", ddl: [
    "IF OBJECT_ID('recon_ties') IS NOT NULL DROP TABLE recon_ties",
    "CREATE TABLE recon_ties (id BIGINT PRIMARY KEY, updated_at DATETIME2(7) NOT NULL, ref VARCHAR(20) NOT NULL, note VARCHAR(20) NULL)",
    "INSERT INTO recon_ties SELECT n, DATEADD(MICROSECOND, ((n - 1) / 7) * 37, CAST('2026-11-19' AS DATETIME2(7))), CONCAT('R', n), CASE n % 3 WHEN 0 THEN NULL WHEN 1 THEN '' ELSE CONCAT('n', n) END "
      + "FROM (SELECT TOP 70 ROW_NUMBER() OVER (ORDER BY (SELECT NULL)) AS n FROM sys.all_objects) x",
  ] },
  oracle: { table: "RECON_TIES", wm: "UPDATED_AT", id: "ID", ddl: [
    "BEGIN EXECUTE IMMEDIATE 'DROP TABLE RECON_TIES'; EXCEPTION WHEN OTHERS THEN NULL; END;",
    "CREATE TABLE RECON_TIES (ID NUMBER(19,0) PRIMARY KEY, UPDATED_AT TIMESTAMP(6) WITH TIME ZONE NOT NULL, REF VARCHAR2(20) NOT NULL, NOTE VARCHAR2(20))",
    "INSERT INTO RECON_TIES SELECT LEVEL, TIMESTAMP '2026-11-19 00:00:00 UTC' + NUMTODSINTERVAL(FLOOR((LEVEL - 1) / 7) * 37 / 1000000, 'SECOND'), 'R' || LEVEL, "
      + "CASE MOD(LEVEL, 3) WHEN 0 THEN NULL WHEN 1 THEN NULL ELSE 'n' || LEVEL END FROM DUAL CONNECT BY LEVEL <= 70",
  ] },
};

/** Runs the setup DDL through the engine's driver (outside the connector, whose session only reads). */
async function setup(engine: Exclude<DbEngine, "postgres">, s: Secret): Promise<void> {
  const ddl = SETUP[engine].ddl;
  if (engine === "mysql") {
    const c = await createConnection({ host: s.host, port: s.port, user: s.user, password: s.password, database: s.database });
    for (const q of ddl) await c.query(q);
    await c.end();
  } else if (engine === "mssql") {
    const p = await new ConnectionPool({ server: s.host, port: s.port, user: s.user, password: s.password, database: s.database, options: { encrypt: false, trustServerCertificate: true } }).connect();
    for (const q of ddl) await p.request().query(q);
    await p.close();
  } else {
    const c = await oracledb.getConnection({ user: s.user, password: s.password, connectString: `${s.host}:${s.port}/${s.database}` });
    for (const q of ddl) await c.execute(q);
    await c.commit();
    await c.close();
  }
}

for (const [engine, env, port] of ENGINES) {
  const url = process.env[env];
  describe(`${engine} connector against a real server`, () => {
    if (!url) {
      it.skip(`skipped: set ${env} to run the ${engine} connector against a real server${engine === "oracle" ? " (REC-F2 go-live gate)" : ""}`, () => {});
      return;
    }
    const s = secretOf(url, port);
    const e = engine as Exclude<DbEngine, "postgres">;
    const t = SETUP[e];
    const conn = (): Connector => connectorFor(engine, s, { tls: false, connectTimeoutSeconds: 10, statementTimeoutMs: 30_000 });

    it("test, introspect, keyset pull across tied timestamps (each row once), NULL kept apart", async () => {
      await setup(e, s);
      const c = conn();
      try {
        await c.test();
        const cols = await c.introspect({ table: t.table });
        expect(cols.map((x) => x.name.toLowerCase())).toEqual(["id", "updated_at", "ref", "note"]);
        const ref = engine === "oracle" ? "REF" : "ref", note = engine === "oracle" ? "NOTE" : "note";
        const rows = await all(c.pullWatermark({ from: { table: t.table }, columns: [ref, note], watermark: { column: t.wm, id_columns: [t.id] }, after: null, lookback: { seconds: 0 }, chunk: 5 }));
        expect(rows.map((r) => r[ref])).toEqual(Array.from({ length: 70 }, (_, i) => `R${i + 1}`));
        expect(rows[2]![note]).toBeNull();
        const at = rows[32]!;
        const rest = await all(c.pullWatermark({ from: { table: t.table }, columns: [ref], watermark: { column: t.wm, id_columns: [t.id] }, after: { wm: at[t.wm]!, ids: [at[t.id]!] }, lookback: { seconds: 0 }, chunk: 4 }));
        expect(rest.map((r) => r[ref])).toEqual(Array.from({ length: 37 }, (_, i) => `R${i + 34}`));
        const sample = await c.sample({ table: t.table }, [ref], 10);
        expect(sample).toHaveLength(10);
      } finally {
        await c.close();
      }
    }, 120_000);

    it("a wrong password is the login class with the engine's code", async () => {
      const c = connectorFor(engine, { ...s, password: `${s.password}-wrong` }, { tls: false, connectTimeoutSeconds: 10, statementTimeoutMs: 10_000 });
      const err = await c.test().then(() => null, (x) => x);
      await c.close();
      expect(err?.kind).toBe("login");
    }, 30_000);
  });
}
