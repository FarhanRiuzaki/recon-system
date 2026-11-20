// The source catalog SQL behind the wizard's pickers (connectors/dialect.ts, REC-F2a), pinned per dialect: fixed text,
// every value a bound parameter (search text, schema, the paging key), only what the login may open or SELECT, results
// capped. A change to any of these strings is a change to what is sent to a bank's database: review it as such.
import { describe, expect, it } from "bun:test";
import { connectorOver, type Driver } from "../../connectors";
import { catalogSql, databasesSql, likeContains, serverSql, tableCountSql, tablesSql } from "../../connectors/dialect";

/** The readable tables and views of each dialect, as the inner `o` of every catalog query. */
const OBJECTS = {
  postgres: "SELECT c.oid AS id, ns.nspname AS s, c.relname AS n, CASE WHEN c.relkind IN ('v', 'm') THEN 'view' ELSE 'table' END AS k "
    + "FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f') AND NOT c.relispartition "
    + "AND ns.nspname <> 'information_schema' AND ns.nspname NOT LIKE 'pg!_%' ESCAPE '!' AND has_schema_privilege(ns.oid, 'USAGE') AND has_table_privilege(c.oid, 'SELECT')",
  mysql: "SELECT TABLE_SCHEMA AS s, TABLE_NAME AS n, CASE WHEN TABLE_TYPE = 'VIEW' THEN 'view' ELSE 'table' END AS k FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()",
  mssql: "SELECT x.object_id AS id, sc.name AS s, x.name AS n, CASE WHEN x.type = 'V' THEN 'view' ELSE 'table' END AS k FROM sys.objects x JOIN sys.schemas sc ON sc.schema_id = x.schema_id "
    + "WHERE x.type IN ('U', 'V') AND x.is_ms_shipped = 0 AND HAS_PERMS_BY_NAME(QUOTENAME(sc.name) + '.' + QUOTENAME(x.name), 'OBJECT', 'SELECT') = 1",
  oracle: "SELECT u.s, u.n, u.k FROM (SELECT OWNER AS s, TABLE_NAME AS n, 'table' AS k FROM ALL_TABLES WHERE NESTED = 'NO' AND SECONDARY = 'N' AND DROPPED = 'NO' "
    + "UNION ALL SELECT OWNER AS s, VIEW_NAME AS n, 'view' AS k FROM ALL_VIEWS) u WHERE u.s NOT IN (SELECT USERNAME FROM ALL_USERS WHERE ORACLE_MAINTAINED = 'Y')",
};
const page = { q: "Tx_%", after: { schema: "core", name: "a" }, limit: 51 };

describe("likeContains", () => {
  it("lower-cases and escapes the LIKE wildcards and the escape itself with ! (and [ for SQL Server)", () => {
    expect(likeContains("Tx_%")).toBe("%tx!_!%%");
    expect(likeContains("a!b[c")).toBe("%a!!b![c%");
  });
});

describe("tablesSql: one page of the tables and views the login can SELECT", () => {
  it("PostgreSQL: USAGE on the schema and SELECT on the table, system schemas and partitions left out, search and keyset bound, LIMIT", () => {
    const b = tablesSql("postgres", page);
    expect(b.sql).toBe(`SELECT o.s AS "schema", o.n AS "name", o.k AS "kind", (SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = o.id AND a.attnum > 0 AND NOT a.attisdropped) AS "columns" `
      + `FROM (${OBJECTS.postgres}) o WHERE (LOWER(o.n) LIKE $1 ESCAPE '!' OR LOWER(o.s) LIKE $2 ESCAPE '!') AND (o.s, o.n) > ($3, $4) ORDER BY o.s, o.n LIMIT 51`);
    expect(b.params).toEqual(["%tx!_!%%", "%tx!_!%%", "core", "a"]);
    expect(tablesSql("postgres", { limit: 51 }).sql).toEndWith(`FROM (${OBJECTS.postgres}) o ORDER BY o.s, o.n LIMIT 51`);
  });

  it("MySQL: the connected database's tables (information_schema lists only what the login holds), ? per use", () => {
    const b = tablesSql("mysql", page);
    expect(b.sql).toBe("SELECT o.s AS `schema`, o.n AS `name`, o.k AS `kind`, (SELECT COUNT(*) FROM information_schema.COLUMNS c WHERE c.TABLE_SCHEMA = o.s AND c.TABLE_NAME = o.n) AS `columns` "
      + `FROM (${OBJECTS.mysql}) o WHERE (LOWER(o.n) LIKE ? ESCAPE '!' OR LOWER(o.s) LIKE ? ESCAPE '!') AND (o.s > ? OR (o.s = ? AND o.n > ?)) ORDER BY o.s, o.n LIMIT 51`);
    expect(b.params).toEqual(["%tx!_!%%", "%tx!_!%%", "core", "core", "a"]);
  });

  it("SQL Server: HAS_PERMS_BY_NAME … SELECT, shipped objects left out, @p parameters, OFFSET … FETCH", () => {
    const b = tablesSql("mssql", page);
    expect(b.sql).toBe("SELECT o.s AS [schema], o.n AS [name], o.k AS [kind], (SELECT COUNT(*) FROM sys.columns c WHERE c.object_id = o.id) AS [columns] "
      + `FROM (${OBJECTS.mssql}) o WHERE (LOWER(o.n) LIKE @p0 ESCAPE '!' OR LOWER(o.s) LIKE @p1 ESCAPE '!') AND (o.s > @p2 OR (o.s = @p3 AND o.n > @p4)) `
      + "ORDER BY o.s, o.n OFFSET 0 ROWS FETCH NEXT 51 ROWS ONLY");
    expect(b.params).toEqual(["%tx!_!%%", "%tx!_!%%", "core", "core", "a"]);
  });

  it("Oracle: ALL_TABLES and ALL_VIEWS outside the Oracle-maintained schemas, one schema bound, FETCH FIRST", () => {
    const b = tablesSql("oracle", { ...page, schema: "CORE" });
    expect(b.sql).toBe(`SELECT o.s AS "schema", o.n AS "name", o.k AS "kind", (SELECT COUNT(*) FROM ALL_TAB_COLUMNS c WHERE c.OWNER = o.s AND c.TABLE_NAME = o.n) AS "columns" `
      + `FROM (${OBJECTS.oracle}) o WHERE o.s = :p0 AND (LOWER(o.n) LIKE :p1 ESCAPE '!' OR LOWER(o.s) LIKE :p2 ESCAPE '!') AND (o.s > :p3 OR (o.s = :p4 AND o.n > :p5)) `
      + "ORDER BY o.s, o.n FETCH FIRST 51 ROWS ONLY");
    expect(b.params).toEqual(["CORE", "%tx!_!%%", "%tx!_!%%", "core", "core", "a"]);
  });

  it("search text and names never reach the SQL text; the page size must be a positive integer", () => {
    const evil = "x' OR 1=1 --";
    for (const d of ["postgres", "mysql", "mssql", "oracle"] as const) {
      const b = tablesSql(d, { q: evil, schema: evil, after: { schema: evil, name: evil }, limit: 51 });
      expect(b.sql).not.toContain("1=1");
      expect(b.params.every((v) => v!.includes("1=1"))).toBe(true);
    }
    expect(() => tablesSql("postgres", { limit: 0 })).toThrow("limit must be a positive integer");
    expect(() => tablesSql("postgres", { limit: 1.5 })).toThrow("limit must be a positive integer");
  });
});

describe("tableCountSql: a count that stops at the cap", () => {
  it("counts at most `cap` rows of the same objects, per dialect", () => {
    expect(tableCountSql("postgres", { schema: "core" }, 10_001)).toEqual({ sql: `SELECT COUNT(*) AS "n" FROM (SELECT 1 AS one FROM (${OBJECTS.postgres}) o WHERE o.s = $1 LIMIT 10001) x`, params: ["core"] });
    expect(tableCountSql("mysql", {}, 10_001).sql).toBe(`SELECT COUNT(*) AS \`n\` FROM (SELECT 1 AS one FROM (${OBJECTS.mysql}) o LIMIT 10001) x`);
    expect(tableCountSql("mssql", { q: "a" }, 10_001)).toEqual({
      sql: `SELECT COUNT(*) AS [n] FROM (SELECT 1 AS one FROM (${OBJECTS.mssql}) o WHERE (LOWER(o.n) LIKE @p0 ESCAPE '!' OR LOWER(o.s) LIKE @p1 ESCAPE '!') ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 10001 ROWS ONLY) x`,
      params: ["%a%", "%a%"],
    });
    expect(tableCountSql("oracle", { schema: "CORE" }, 10_001).sql).toBe(`SELECT COUNT(*) AS "n" FROM (SELECT 1 AS one FROM (${OBJECTS.oracle}) o WHERE o.s = :p0 FETCH FIRST 10001 ROWS ONLY) x`);
  });
});

describe("databasesSql: what the login can open, 501 read (500 shown, one more tells it was cut)", () => {
  it("PostgreSQL CONNECT, MySQL's schemata without the system ones, SQL Server HAS_DBACCESS without the system databases, Oracle the readable schemas", () => {
    expect(databasesSql("postgres")).toBe("SELECT datname AS name FROM pg_database WHERE datallowconn AND NOT datistemplate AND has_database_privilege(datname, 'CONNECT') ORDER BY datname LIMIT 501");
    expect(databasesSql("mysql")).toBe("SELECT SCHEMA_NAME AS `name` FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys') ORDER BY SCHEMA_NAME LIMIT 501");
    expect(databasesSql("mssql")).toBe("SELECT name AS [name] FROM sys.databases WHERE database_id > 4 AND state = 0 AND HAS_DBACCESS(name) = 1 ORDER BY name OFFSET 0 ROWS FETCH NEXT 501 ROWS ONLY");
    expect(databasesSql("oracle")).toBe(`SELECT DISTINCT o.s AS "name" FROM (${OBJECTS.oracle}) o ORDER BY 1 FETCH FIRST 501 ROWS ONLY`);
  });
});

describe("serverSql: version, login and database for the test's sentence", () => {
  it("per dialect, no parameter", () => {
    expect(serverSql("postgres")).toBe(`SELECT current_setting('server_version') AS version, current_user AS "user", current_database() AS database`);
    expect(serverSql("mysql")).toBe("SELECT VERSION() AS `version`, SUBSTRING_INDEX(CURRENT_USER(), '@', 1) AS `user`, DATABASE() AS `database`");
    expect(serverSql("mssql")).toBe("SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS [version], SUSER_SNAME() AS [user], DB_NAME() AS [database]");
    expect(serverSql("oracle")).toBe(`SELECT (SELECT MAX(VERSION) FROM PRODUCT_COMPONENT_VERSION WHERE PRODUCT LIKE 'Oracle%') AS "version", USER AS "user", SYS_CONTEXT('USERENV', 'DB_NAME') AS "database" FROM DUAL`);
  });
});

describe("catalogSql: a table's columns with unique and indexed", () => {
  it("PostgreSQL: unique = alone a key of a unique index without a predicate (primary keys are unique indexes); indexed = leads an index", () => {
    const b = catalogSql("postgres", "core.txn");
    expect(b.sql).toBe("SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS nullable, "
      + `CASE WHEN EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisunique AND i.indnkeyatts = 1 AND i.indkey[0] = a.attnum AND i.indpred IS NULL) THEN 'YES' ELSE 'NO' END AS "unique", `
      + "CASE WHEN EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indkey[0] = a.attnum) THEN 'YES' ELSE 'NO' END AS indexed "
      + "FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace "
      + "WHERE ns.nspname = coalesce($1, current_schema()) AND c.relname = $2 AND c.relkind IN ('r', 'v', 'm', 'p', 'f') AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum");
    expect(b.params).toEqual(["core", "txn"]);
  });

  it("MySQL: COLUMN_KEY (UNI, or PRI of a one-column primary key; indexed when any key)", () => {
    expect(catalogSql("mysql", "txn")).toEqual({
      sql: "SELECT COLUMN_NAME AS `name`, COLUMN_TYPE AS `type`, IS_NULLABLE AS `nullable`, "
        + "CASE WHEN COLUMN_KEY = 'UNI' OR (COLUMN_KEY = 'PRI' AND (SELECT COUNT(*) FROM information_schema.COLUMNS k WHERE k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME AND k.COLUMN_KEY = 'PRI') = 1) THEN 'YES' ELSE 'NO' END AS `unique`, "
        + "CASE WHEN COLUMN_KEY <> '' THEN 'YES' ELSE 'NO' END AS `indexed` FROM information_schema.COLUMNS c WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
      params: [null, "txn"],
    });
  });

  it("SQL Server: a one-key unique index without a filter (a primary key is one); indexed = first key of an index", () => {
    const b = catalogSql("mssql", "dbo.txn");
    expect(b.sql).toContain("AS [nullable], CASE WHEN EXISTS (SELECT 1 FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id "
      + "WHERE i.object_id = OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME)) AND i.is_unique = 1 AND i.has_filter = 0 AND ic.key_ordinal = 1 AND COL_NAME(ic.object_id, ic.column_id) = c.COLUMN_NAME "
      + "AND (SELECT COUNT(*) FROM sys.index_columns k WHERE k.object_id = i.object_id AND k.index_id = i.index_id AND k.key_ordinal > 0) = 1) THEN 'YES' ELSE 'NO' END AS [unique], "
      + "CASE WHEN EXISTS (SELECT 1 FROM sys.index_columns ic WHERE ic.object_id = OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME)) AND ic.key_ordinal = 1 AND COL_NAME(ic.object_id, ic.column_id) = c.COLUMN_NAME) THEN 'YES' ELSE 'NO' END AS [indexed] "
      + "FROM INFORMATION_SCHEMA.COLUMNS c WHERE TABLE_SCHEMA = COALESCE(@p0, SCHEMA_NAME()) AND TABLE_NAME = @p1 ORDER BY ORDINAL_POSITION");
    expect(b.params).toEqual(["dbo", "txn"]);
  });

  it("Oracle: a one-column P or U constraint; indexed = first column of an index", () => {
    const b = catalogSql("oracle", "CORE.TXN");
    expect(b.sql).toContain(`NULLABLE AS "nullable", CASE WHEN EXISTS (SELECT 1 FROM ALL_CONSTRAINTS k JOIN ALL_CONS_COLUMNS cc ON cc.OWNER = k.OWNER AND cc.CONSTRAINT_NAME = k.CONSTRAINT_NAME `
      + "WHERE k.OWNER = c.OWNER AND k.TABLE_NAME = c.TABLE_NAME AND k.CONSTRAINT_TYPE IN ('P', 'U') AND cc.COLUMN_NAME = c.COLUMN_NAME "
      + `AND (SELECT COUNT(*) FROM ALL_CONS_COLUMNS x WHERE x.OWNER = k.OWNER AND x.CONSTRAINT_NAME = k.CONSTRAINT_NAME) = 1) THEN 'YES' ELSE 'NO' END AS "unique", `
      + `CASE WHEN EXISTS (SELECT 1 FROM ALL_IND_COLUMNS ic WHERE ic.TABLE_OWNER = c.OWNER AND ic.TABLE_NAME = c.TABLE_NAME AND ic.COLUMN_NAME = c.COLUMN_NAME AND ic.COLUMN_POSITION = 1) THEN 'YES' ELSE 'NO' END AS "indexed" `
      + "FROM ALL_TAB_COLUMNS c WHERE OWNER = COALESCE(:p0, USER) AND TABLE_NAME = :p1 ORDER BY COLUMN_ID");
    expect(b.params).toEqual(["CORE", "TXN"]);
  });
});

describe("the connector's catalog calls over a driver", () => {
  const over = (rows: (sql: string, params: (string | null)[]) => Record<string, unknown>[]) => {
    const sent: { sql: string; params: (string | null)[] }[] = [];
    const drv: Driver = { rows: async (sql, params) => { sent.push({ sql, params }); return rows(sql, params); }, describe: async () => [], stream: async function* () {}, close: async () => {} };
    return { c: connectorOver("postgres", drv, { connectS: 1, statementS: 1 }), sent };
  };

  it("tables: 51 read, 50 answered, the next page starts after the 50th", async () => {
    const all = Array.from({ length: 51 }, (_, i) => ({ schema: "core", name: `t${String(i).padStart(2, "0")}`, kind: i === 3 ? "view" : "table", columns: String(i) }));
    const { c, sent } = over(() => all);
    const r = await c.tables({ q: "t" });
    expect(r.items).toHaveLength(50);
    expect(r.items[3]).toEqual({ schema: "core", name: "t03", kind: "view", columns: 3 });
    expect(r.next).toEqual({ schema: "core", name: "t49" });
    expect(sent[0]!.sql).toEndWith("LIMIT 51");
    const short = over(() => all.slice(0, 2));
    expect((await short.c.tables({})).next).toBeNull();
  });

  it("databases: 500 shown and cut when 501 come back; introspect reads unique and indexed, a SELECT leaves them null", async () => {
    const { c } = over((sql) => (sql.includes("pg_database") ? Array.from({ length: 501 }, (_, i) => ({ name: `db${i}` }))
      : [{ name: "id", type: "bigint", nullable: "NO", unique: "YES", indexed: "YES" }, { name: "at", type: "timestamptz", nullable: "NO", unique: "NO", indexed: "NO" }]));
    const d = await c.databases();
    expect([d.names.length, d.truncated]).toEqual([500, true]);
    expect(await c.introspect({ table: "t" })).toEqual([
      { name: "id", type: "bigint", nullable: false, unique: true, indexed: true }, { name: "at", type: "timestamptz", nullable: false, unique: false, indexed: false },
    ]);
  });
});
