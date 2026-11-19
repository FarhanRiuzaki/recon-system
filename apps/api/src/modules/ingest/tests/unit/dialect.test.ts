// The per-dialect SQL of the source connectors (connectors/dialect.ts): quoting, the text form of each column family,
// the keyset predicate, the paging clause, the catalog query, the custom-SELECT check and the :business_date binding.
import { describe, expect, it } from "bun:test";
import { checkSelect, type Column, familyOf, minusSeconds, quoteIdent, rowsSql, tableName } from "../../connectors/dialect";
import { ConnectorError } from "../../connectors/errors";

const col = (name: string, type: string): Column => ({ name, type, nullable: false });
const err = (fn: () => unknown) => { try { fn(); } catch (e) { return e as ConnectorError; } throw new Error("did not throw"); };

describe("quoteIdent", () => {
  it("quotes per dialect and doubles the closing quote", () => {
    expect(quoteIdent("postgres", 'a"b')).toBe('"a""b"');
    expect(quoteIdent("oracle", "ACCT_NO")).toBe('"ACCT_NO"');
    expect(quoteIdent("mysql", "a`b")).toBe("`a``b`");
    expect(quoteIdent("mssql", "a]b")).toBe("[a]]b]");
  });
});

describe("tableName", () => {
  it("takes table or schema.table of identifier characters only", () => {
    expect(tableName("txn")).toEqual({ schema: null, name: "txn" });
    expect(tableName("core.TXN_2026")).toEqual({ schema: "core", name: "TXN_2026" });
    for (const bad of ["a.b.c", "x;drop", "1abc", "a b", '"x"', "", "a.", "a/*"]) expect(err(() => tableName(bad)).kind).toBe("spec");
  });
});

describe("familyOf", () => {
  it("maps each engine's type names to the family that decides the text form", () => {
    expect(["timestamp with time zone", "timestamp(3) with time zone", "timestamp without time zone", "date", "bigint", "numeric(18,2)", "boolean", "text"].map((t) => familyOf("postgres", t)))
      .toEqual(["tstz", "tstz", "ts", "date", "int", "num", "bool", "text"]);
    expect(["timestamp(6)", "datetime(6)", "date", "bigint unsigned", "tinyint(1)", "longlong", "decimal(18,2)", "newdecimal", "varchar(20)", "long_blob"].map((t) => familyOf("mysql", t)))
      .toEqual(["tstz", "ts", "date", "int", "int", "int", "num", "num", "text", "text"]);
    expect(["datetimeoffset", "datetime2", "datetime", "date", "int", "decimal(18,2)", "bit", "nvarchar(max)"].map((t) => familyOf("mssql", t)))
      .toEqual(["tstz", "ts", "ts", "date", "int", "num", "bool", "text"]);
    expect(["TIMESTAMP(6) WITH TIME ZONE", "TIMESTAMP(6) WITH LOCAL TIME ZONE", "TIMESTAMP(6)", "DATE", "NUMBER(10,0)", "NUMBER", "NUMBER(18,2)", "VARCHAR2"].map((t) => familyOf("oracle", t)))
      .toEqual(["tstz", "tstz", "ts", "ts", "int", "num", "num", "text"]);
  });
});

describe("checkSelect", () => {
  it("accepts one SELECT or WITH, trimmed", () => {
    expect(checkSelect("postgres", "  select a from t where b = 'x'\n")).toBe("select a from t where b = 'x'");
    expect(checkSelect("oracle", "WITH x AS (SELECT 1 a FROM DUAL) SELECT a FROM x")).toStartWith("WITH");
  });
  it("refuses ';', comments, anything else, and WITH on SQL Server (a CTE can't sit in a derived table)", () => {
    for (const q of ["select 1; drop table t", "select 1 -- x", "select /* x */ 1", "delete from t", "update t set a = 1", "(select 1)", "insert into t select 1"]) {
      expect([q, err(() => checkSelect("postgres", q)).kind]).toEqual([q, "spec"]);
    }
    expect(err(() => checkSelect("mssql", "with x as (select 1 a) select a from x")).message).toContain("SQL Server");
  });
});

describe("minusSeconds", () => {
  it("moves a text watermark back keeping its microseconds and its form", () => {
    expect(minusSeconds("2026-11-19T00:00:30.123456Z", 60)).toBe("2026-11-18T23:59:30.123456Z");
    expect(minusSeconds("2026-11-19T00:00:30.1234567", 1)).toBe("2026-11-19T00:00:29.1234567");
    expect(minusSeconds("2026-11-19T00:00:30", 30)).toBe("2026-11-19T00:00:00");
    expect(minusSeconds("2026-11-19", 86_400)).toBe("2026-11-18");
    expect(minusSeconds("2026-11-19", 1)).toBe("2026-11-18");
    expect(minusSeconds("2026-11-19T00:00:30.5Z", 0)).toBe("2026-11-19T00:00:30.5Z");
  });
});

describe("rowsSql", () => {
  const cols = [col("ref", "text"), col("amount", "numeric(18,2)"), col("updated_at", "timestamp with time zone"), col("id", "bigint")];
  const keyset = (wm: Column, id: Column) => ({ wm, id, cursor: { after: { wm: "2026-11-19T00:00:00.000001Z", id: "42" } } as const });

  it("PostgreSQL: text forms, a row comparison on the real columns (not the text aliases), LIMIT", () => {
    const b = rowsSql("postgres", { from: { table: "core.txn" }, columns: cols, keyset: keyset(cols[2]!, cols[3]!), limit: 10_000 });
    expect(b.sql).toBe('SELECT t."ref"::text AS "ref", t."amount"::text AS "amount", '
      + `to_char(t."updated_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updated_at", t."id"::text AS "id" `
      + 'FROM "core"."txn" t WHERE (t."updated_at", t."id") > ($1, $2) ORDER BY t."updated_at", t."id" LIMIT 10000');
    expect(b.params).toEqual(["2026-11-19T00:00:00.000001Z", "42"]);
  });

  it("MySQL: the keyset spelled out (no row comparison), values parsed back from their text form, LIMIT", () => {
    const c = [col("updated_at", "datetime(6)"), col("id", "bigint")];
    const b = rowsSql("mysql", { from: { table: "txn" }, columns: c, keyset: keyset(c[0]!, c[1]!), limit: 500 });
    expect(b.sql).toBe("SELECT DATE_FORMAT(t.`updated_at`, '%Y-%m-%dT%H:%i:%s.%f') AS `updated_at`, CAST(t.`id` AS CHAR) AS `id` FROM `txn` t "
      + "WHERE (t.`updated_at` > STR_TO_DATE(?, '%Y-%m-%dT%H:%i:%s.%f') OR (t.`updated_at` = STR_TO_DATE(?, '%Y-%m-%dT%H:%i:%s.%f') AND t.`id` > CAST(? AS DECIMAL(65,0)))) "
      + "ORDER BY t.`updated_at`, t.`id` LIMIT 500");
    expect(b.params).toEqual(["2026-11-19T00:00:00.000001Z", "2026-11-19T00:00:00.000001Z", "42"]);
  });

  it("SQL Server: named parameters, OFFSET … FETCH NEXT", () => {
    const c = [col("updated_at", "datetimeoffset"), col("id", "int")];
    const b = rowsSql("mssql", { from: { table: "dbo.txn" }, columns: c, keyset: keyset(c[0]!, c[1]!), limit: 200 });
    expect(b.sql).toBe("SELECT CONVERT(varchar(34), SWITCHOFFSET(t.[updated_at], '+00:00'), 127) AS [updated_at], CAST(t.[id] AS nvarchar(max)) AS [id] FROM [dbo].[txn] t "
      + "WHERE (t.[updated_at] > CAST(@p0 AS datetimeoffset(7)) OR (t.[updated_at] = CAST(@p1 AS datetimeoffset(7)) AND t.[id] > CAST(@p2 AS bigint))) "
      + "ORDER BY t.[updated_at], t.[id] OFFSET 0 ROWS FETCH NEXT 200 ROWS ONLY");
    expect(b.params).toHaveLength(3);
  });

  it("Oracle: TO_CHAR text forms (DATE keeps its time), FETCH FIRST", () => {
    const c = [col("UPDATED_AT", "TIMESTAMP(6) WITH TIME ZONE"), col("ID", "NUMBER(19,0)"), col("BOOKED", "DATE")];
    const b = rowsSql("oracle", { from: { table: "CORE.TXN" }, columns: c, keyset: keyset(c[0]!, c[1]!), limit: 1000 });
    expect(b.sql).toBe(`SELECT TO_CHAR(SYS_EXTRACT_UTC(t."UPDATED_AT"), 'YYYY-MM-DD"T"HH24:MI:SS.FF6"Z"') AS "UPDATED_AT", `
      + `TO_CHAR(t."ID", 'TM9', 'NLS_NUMERIC_CHARACTERS=''.,''') AS "ID", TO_CHAR(t."BOOKED", 'YYYY-MM-DD"T"HH24:MI:SS') AS "BOOKED" FROM "CORE"."TXN" t `
      + `WHERE (t."UPDATED_AT" > FROM_TZ(TO_TIMESTAMP(:p0, 'YYYY-MM-DD"T"HH24:MI:SS.FF6"Z"'), 'UTC') OR (t."UPDATED_AT" = FROM_TZ(TO_TIMESTAMP(:p1, 'YYYY-MM-DD"T"HH24:MI:SS.FF6"Z"'), 'UTC') AND t."ID" > TO_NUMBER(:p2))) `
      + `ORDER BY t."UPDATED_AT", t."ID" FETCH FIRST 1000 ROWS ONLY`);
  });

  it("a lookback start is `>=` on the watermark only; a sample has no predicate and no order", () => {
    const from = rowsSql("postgres", { from: { table: "txn" }, columns: cols, keyset: { wm: cols[2]!, id: cols[3]!, cursor: { from: "2026-11-18T23:59:00Z" } }, limit: 5 });
    expect(from.sql).toContain('WHERE t."updated_at" >= $1 ORDER BY t."updated_at", t."id" LIMIT 5');
    expect(rowsSql("postgres", { from: { table: "txn" }, columns: cols.slice(0, 1), limit: 200 }).sql).toBe('SELECT t."ref"::text AS "ref" FROM "txn" t LIMIT 200');
    expect(rowsSql("mssql", { from: { table: "txn" }, columns: [col("ref", "varchar")], limit: 200 }).sql).toEndWith("ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 200 ROWS ONLY");
    expect(rowsSql("postgres", { from: { table: "txn" }, columns: cols, keyset: { wm: cols[2]!, id: cols[3]!, cursor: null }, limit: 5 }).sql)
      .toEndWith('FROM "txn" t WHERE t."updated_at" IS NOT NULL ORDER BY t."updated_at", t."id" LIMIT 5'); // a NULL watermark has no place in the keyset
  });

  it("a custom SELECT is wrapped as a subquery; :business_date becomes a bound date parameter (never text in the SQL)", () => {
    const q = "select sid, qty from pos where business_date = :business_date and x::date < :business_date";
    const pg = rowsSql("postgres", { from: { query: q, businessDate: "2026-11-02" }, columns: [col("sid", "text")] });
    expect(pg.sql).toBe('SELECT t."sid"::text AS "sid" FROM (select sid, qty from pos where business_date = CAST($1 AS date) and x::date < CAST($2 AS date)) t');
    expect(pg.params).toEqual(["2026-11-02", "2026-11-02"]);
    expect(rowsSql("mysql", { from: { query: q, businessDate: "2026-11-02" }, columns: [col("sid", "varchar")] }).sql).toContain("business_date = CAST(? AS DATE)");
    expect(rowsSql("mssql", { from: { query: "select sid from pos where d = :business_date", businessDate: "2026-11-02" }, columns: [col("sid", "varchar")] }).sql).toContain("d = CAST(@p0 AS date)");
    expect(rowsSql("oracle", { from: { query: "SELECT SID FROM POS WHERE D = :business_date", businessDate: "2026-11-02" }, columns: [col("SID", "VARCHAR2")] }).sql)
      .toContain("D = TO_DATE(:p0, 'YYYY-MM-DD')");
    expect(err(() => rowsSql("postgres", { from: { query: "select 1; select 2" }, columns: [col("a", "int")] })).kind).toBe("spec");
  });

  it("refuses a watermark that is not a date or time, and an id that is not a number or text", () => {
    const e = err(() => rowsSql("postgres", { from: { table: "t" }, columns: cols, keyset: { wm: cols[0]!, id: cols[3]!, cursor: null }, limit: 5 }));
    expect([e.kind, e.message]).toEqual(["spec", 'The watermark column "ref" is text; it must be a date or a timestamp.']);
    expect(err(() => rowsSql("postgres", { from: { table: "t" }, columns: cols, keyset: { wm: cols[2]!, id: col("flag", "boolean"), cursor: null }, limit: 5 })).kind).toBe("spec");
  });
});
