// The per-dialect SQL of the source connectors (connectors/dialect.ts): quoting, the text form of each column family,
// the keyset predicate, the paging clause, the catalog query, the custom-SELECT check and the :business_date binding.
import { describe, expect, it } from "bun:test";
import { checkSelect, type Column, familyOf, lookbackOf, minusIds, minusSeconds, nullProbeSql, quoteIdent, rowsSql, tableName } from "../../connectors/dialect";
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
    expect(err(() => checkSelect("mysql", "select a from t # where x")).message).toBe("The query must have no comments (-- or /* */ or #).");
    expect(checkSelect("postgres", "select '#' as h")).toBe("select '#' as h");
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
  const keyset = (wm: Column, id: Column) => ({ wm, ids: [id], cursor: { after: { wm: "2026-11-19T00:00:00.000001Z", ids: ["42"] } } as const });

  it("PostgreSQL: text forms, a row comparison on the real columns (not the text aliases), LIMIT", () => {
    const b = rowsSql("postgres", { from: { table: "core.txn" }, columns: cols, keyset: keyset(cols[2]!, cols[3]!), limit: 10_000 });
    expect(b.sql).toBe('SELECT t."ref"::text AS "ref", t."amount"::text AS "amount", '
      + `to_char(t."updated_at" at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updated_at", t."id"::text AS "id" `
      + 'FROM "core"."txn" t WHERE (t."updated_at", t."id") > ($1, $2) ORDER BY t."updated_at", t."id" LIMIT 10000');
    expect(b.params).toEqual(["2026-11-19T00:00:00.000001Z", "42"]);
  });

  it("MySQL: the keyset spelled out as a range on the watermark (an index on (watermark, id) seeks), values parsed back from their text form, LIMIT", () => {
    const c = [col("updated_at", "datetime(6)"), col("id", "bigint")];
    const b = rowsSql("mysql", { from: { table: "txn" }, columns: c, keyset: keyset(c[0]!, c[1]!), limit: 500 });
    expect(b.sql).toBe("SELECT DATE_FORMAT(t.`updated_at`, '%Y-%m-%dT%H:%i:%s.%f') AS `updated_at`, CAST(t.`id` AS CHAR) AS `id` FROM `txn` t "
      + "WHERE t.`updated_at` >= STR_TO_DATE(?, '%Y-%m-%dT%H:%i:%s.%f') AND (t.`updated_at` > STR_TO_DATE(?, '%Y-%m-%dT%H:%i:%s.%f') OR t.`id` > CAST(? AS DECIMAL(65,0))) "
      + "ORDER BY t.`updated_at`, t.`id` LIMIT 500");
    expect(b.params).toEqual(["2026-11-19T00:00:00.000001Z", "2026-11-19T00:00:00.000001Z", "42"]);
  });

  it("SQL Server: named parameters, OFFSET … FETCH NEXT", () => {
    const c = [col("updated_at", "datetimeoffset"), col("id", "int")];
    const b = rowsSql("mssql", { from: { table: "dbo.txn" }, columns: c, keyset: keyset(c[0]!, c[1]!), limit: 200 });
    expect(b.sql).toBe("SELECT CONVERT(varchar(34), SWITCHOFFSET(t.[updated_at], '+00:00'), 127) AS [updated_at], CAST(t.[id] AS nvarchar(max)) AS [id] FROM [dbo].[txn] t "
      + "WHERE t.[updated_at] >= CAST(@p0 AS datetimeoffset) AND (t.[updated_at] > CAST(@p1 AS datetimeoffset) OR t.[id] > CAST(@p2 AS bigint)) "
      + "ORDER BY t.[updated_at], t.[id] OFFSET 0 ROWS FETCH NEXT 200 ROWS ONLY");
    expect(b.params).toHaveLength(3);
  });

  it("SQL Server: money and float keep every digit (style 2 / 3); a cursor is cast back to the column's own type", () => {
    const c = [col("fee", "money"), col("rate", "float"), col("small", "smallmoney"), col("r", "real")];
    expect(rowsSql("mssql", { from: { table: "t" }, columns: c, limit: 1 }).sql).toStartWith(
      "SELECT CONVERT(nvarchar(max), t.[fee], 2) AS [fee], CONVERT(nvarchar(max), t.[rate], 3) AS [rate], CONVERT(nvarchar(max), t.[small], 2) AS [small], CONVERT(nvarchar(max), t.[r], 3) AS [r]");
    const after = { after: { wm: "2026-11-19T00:00:00.0033333", ids: ["1"] } } as const;
    const where = (wmType: string) => rowsSql("mssql", { from: { table: "t" }, columns: [col("w", wmType), col("i", "int")], keyset: { wm: col("w", wmType), ids: [col("i", "int")], cursor: after }, limit: 5 }).sql;
    // a string parses into datetime/smalldatetime with at most 3 fraction digits: the 7-digit text goes through datetime2(7)
    expect(where("datetime")).toContain("t.[w] >= CAST(CAST(@p0 AS datetime2(7)) AS datetime) AND (t.[w] > CAST(CAST(@p1 AS datetime2(7)) AS datetime) OR t.[i] > ");
    expect(where("smalldatetime")).toContain("t.[w] >= CAST(CAST(@p0 AS datetime2(7)) AS smalldatetime) AND (t.[w] > CAST(CAST(@p1 AS datetime2(7)) AS smalldatetime) OR t.[i] > ");
    expect(where("datetime2(3)")).toContain("t.[w] >= CAST(@p0 AS datetime2(3)) AND (t.[w] > CAST(@p1 AS datetime2(3)) OR t.[i] > ");
    expect(where("datetime2")).toContain("t.[w] >= CAST(@p0 AS datetime2) AND (t.[w] > CAST(@p1 AS datetime2) OR t.[i] > ");
    expect(where("datetimeoffset(7)")).toContain("t.[w] >= CAST(@p0 AS datetimeoffset(7)) AND (t.[w] > CAST(@p1 AS datetimeoffset(7)) OR t.[i] > ");
    // a lookback start from a stored cursor takes the same path
    expect(rowsSql("mssql", { from: { table: "t" }, columns: [col("w", "datetime"), col("i", "int")], keyset: { wm: col("w", "datetime"), ids: [col("i", "int")], cursor: { from: "2026-11-18T23:59:00.0033333" } }, limit: 5 }).sql)
      .toContain("WHERE t.[w] >= CAST(CAST(@p0 AS datetime2(7)) AS datetime) ORDER BY");
  });

  it("Oracle: TO_CHAR text forms (DATE keeps its time), FETCH FIRST", () => {
    const c = [col("UPDATED_AT", "TIMESTAMP(6) WITH TIME ZONE"), col("ID", "NUMBER(19,0)"), col("BOOKED", "DATE")];
    const b = rowsSql("oracle", { from: { table: "CORE.TXN" }, columns: c, keyset: keyset(c[0]!, c[1]!), limit: 1000 });
    expect(b.sql).toBe(`SELECT TO_CHAR(SYS_EXTRACT_UTC(t."UPDATED_AT"), 'YYYY-MM-DD"T"HH24:MI:SS.FF6"Z"') AS "UPDATED_AT", `
      + `TO_CHAR(t."ID", 'TM9', 'NLS_NUMERIC_CHARACTERS=''.,''') AS "ID", TO_CHAR(t."BOOKED", 'YYYY-MM-DD"T"HH24:MI:SS') AS "BOOKED" FROM "CORE"."TXN" t `
      + `WHERE t."UPDATED_AT" >= FROM_TZ(TO_TIMESTAMP(:p0, 'YYYY-MM-DD"T"HH24:MI:SS.FF6"Z"'), 'UTC') AND (t."UPDATED_AT" > FROM_TZ(TO_TIMESTAMP(:p1, 'YYYY-MM-DD"T"HH24:MI:SS.FF6"Z"'), 'UTC') OR t."ID" > TO_NUMBER(:p2)) `
      + `ORDER BY t."UPDATED_AT", t."ID" FETCH FIRST 1000 ROWS ONLY`);
  });

  it("a lookback start is `>=` on the watermark only; a sample has no predicate and no order", () => {
    const from = rowsSql("postgres", { from: { table: "txn" }, columns: cols, keyset: { wm: cols[2]!, ids: [cols[3]!], cursor: { from: "2026-11-18T23:59:00Z" } }, limit: 5 });
    expect(from.sql).toContain('WHERE t."updated_at" >= $1 ORDER BY t."updated_at", t."id" LIMIT 5');
    expect(rowsSql("postgres", { from: { table: "txn" }, columns: cols.slice(0, 1), limit: 200 }).sql).toBe('SELECT t."ref"::text AS "ref" FROM "txn" t LIMIT 200');
    expect(rowsSql("mssql", { from: { table: "txn" }, columns: [col("ref", "varchar")], limit: 200 }).sql).toEndWith("ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 200 ROWS ONLY");
    expect(rowsSql("postgres", { from: { table: "txn" }, columns: cols, keyset: { wm: cols[2]!, ids: [cols[3]!], cursor: null }, limit: 5 }).sql)
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

  it("refuses a watermark that is not a date, time or integer, and an id that is not a number or text", () => {
    const e = err(() => rowsSql("postgres", { from: { table: "t" }, columns: cols, keyset: { wm: cols[0]!, ids: [cols[3]!], cursor: null }, limit: 5 }));
    expect([e.kind, e.message]).toEqual(["spec", 'The watermark column "ref" is text; it must be a date, a timestamp or an integer.']);
    expect(err(() => rowsSql("postgres", { from: { table: "t" }, columns: cols, keyset: { wm: cols[2]!, ids: [col("flag", "boolean")], cursor: null }, limit: 5 })).kind).toBe("spec");
  });
});

type D = "postgres" | "mysql" | "mssql" | "oracle";
// a text id as the keyset orders and compares it: one binary expression around the column and the parameter alike
const MY = (x: string) => `CAST(CONVERT(${x} USING utf8mb4) AS BINARY)`;
const MS = (x: string) => `CAST(CAST(${x} AS nvarchar(max)) AS varbinary(max))`;
const ORA = (x: string) => `NLSSORT(TO_NCHAR(${x}), 'NLS_SORT=BINARY')`;

describe("composite id columns (owner, 24 Nov: rows without one unique column)", () => {
  const after = { after: { wm: "2026-11-19", ids: ["B01", "7"] } } as const;
  const TYPES: Record<D, string[]> = { postgres: ["date", "text", "bigint"], mysql: ["date", "varchar(10)", "bigint"], mssql: ["date", "varchar(10)", "bigint"], oracle: ["TIMESTAMP(6)", "VARCHAR2(10)", "NUMBER(19,0)"] };
  const sql = (d: D) => {
    const k = [col("d", TYPES[d][0]!), col("branch", TYPES[d][1]!), col("seq", TYPES[d][2]!)];
    return rowsSql(d, { from: { table: "t" }, columns: k, keyset: { wm: k[0]!, ids: [k[1]!, k[2]!], cursor: after }, limit: 5 });
  };

  it("PostgreSQL: one row comparison over the watermark and every id, ordered by all of them", () => {
    const b = sql("postgres");
    expect(b.sql).toEndWith('WHERE (t."d", t."branch", t."seq") > ($1, $2, $3) ORDER BY t."d", t."branch", t."seq" LIMIT 5');
    expect(b.params).toEqual(["2026-11-19", "B01", "7"]);
  });

  it("MySQL, SQL Server, Oracle: a range on the watermark, then the ids spelled out in order (no row values), one parameter per use", () => {
    const my = sql("mysql");
    expect(my.sql).toEndWith(`WHERE t.\`d\` >= STR_TO_DATE(?, '%Y-%m-%d') AND (t.\`d\` > STR_TO_DATE(?, '%Y-%m-%d') OR ${MY("t.`branch`")} > ${MY("?")} OR (${MY("t.`branch`")} = ${MY("?")} AND t.\`seq\` > CAST(? AS DECIMAL(65,0)))) `
      + `ORDER BY t.\`d\`, ${MY("t.`branch`")}, t.\`seq\` LIMIT 5`);
    expect(my.params).toEqual(["2026-11-19", "2026-11-19", "B01", "B01", "7"]);
    expect(sql("mssql").sql).toContain(`WHERE t.[d] >= CAST(@p0 AS date) AND (t.[d] > CAST(@p1 AS date) OR ${MS("t.[branch]")} > ${MS("@p2")} OR (${MS("t.[branch]")} = ${MS("@p3")} AND t.[seq] > CAST(@p4 AS bigint))) ORDER BY t.[d], ${MS("t.[branch]")}, t.[seq] OFFSET`);
    expect(sql("oracle").sql).toContain(`OR ${ORA('t."branch"')} > ${ORA(":p2")} OR (${ORA('t."branch"')} = ${ORA(":p3")} AND t."seq" > TO_NUMBER(:p4))) ORDER BY t."d", ${ORA('t."branch"')}, t."seq" FETCH`);
  });

  it("three ids: each later id breaks the tie of all before it", () => {
    const k = [col("w", "datetime2"), col("a", "int"), col("b", "int"), col("c", "int")];
    const b = rowsSql("mssql", { from: { table: "t" }, columns: k, keyset: { wm: k[0]!, ids: k.slice(1), cursor: { after: { wm: "2026-11-19T00:00:00.0000000", ids: ["1", "2", "3"] } } }, limit: 5 });
    expect(b.sql).toContain("OR t.[a] > CAST(@p2 AS bigint) OR (t.[a] = CAST(@p3 AS bigint) AND t.[b] > CAST(@p4 AS bigint)) OR (t.[a] = CAST(@p5 AS bigint) AND t.[b] = CAST(@p6 AS bigint) AND t.[c] > CAST(@p7 AS bigint)))");
    expect(b.sql).toContain("ORDER BY t.[w], t.[a], t.[b], t.[c] OFFSET");
    expect(b.params).toEqual(["2026-11-19T00:00:00.0000000", "2026-11-19T00:00:00.0000000", "1", "1", "2", "1", "2", "3"]);
  });

  it("a cursor with another number of ids than the keyset is refused (never a predicate over the wrong columns)", () => {
    const k = [col("d", "date"), col("branch", "text")];
    expect(() => rowsSql("postgres", { from: { table: "t" }, columns: k, keyset: { wm: k[0]!, ids: [k[1]!], cursor: after }, limit: 5 })).toThrow();
  });
});

describe("an integer watermark (a sequence)", () => {
  it("orders and compares it as a number on every dialect", () => {
    const k = [col("seq", "bigint"), col("id", "bigint")];
    const cursor = { after: { wm: "9007199254740993", ids: ["1"] } } as const;
    expect(rowsSql("postgres", { from: { table: "t" }, columns: k, keyset: { wm: k[0]!, ids: [k[1]!], cursor }, limit: 5 }).sql).toEndWith('WHERE (t."seq", t."id") > ($1, $2) ORDER BY t."seq", t."id" LIMIT 5');
    expect(rowsSql("mssql", { from: { table: "t" }, columns: k, keyset: { wm: k[0]!, ids: [k[1]!], cursor }, limit: 5 }).sql).toContain("WHERE t.[seq] >= CAST(@p0 AS bigint) AND (t.[seq] > CAST(@p1 AS bigint) OR t.[id] > CAST(@p2 AS bigint))");
    const o = [col("SEQ", "NUMBER(19,0)"), col("ID", "NUMBER(19,0)")];
    expect(rowsSql("oracle", { from: { table: "t" }, columns: o, keyset: { wm: o[0]!, ids: [o[1]!], cursor: { from: "9007199254739993" } }, limit: 5 }).sql).toContain(`WHERE t."SEQ" >= TO_NUMBER(:p0) ORDER BY t."SEQ", t."ID"`);
  });

  it("minusIds steps a sequence back exactly, past 2^53 (no JS float)", () => {
    expect(minusIds("9007199254740993", 1000)).toBe("9007199254739993");
    expect(minusIds("12345678901234567890123", 1)).toBe("12345678901234567890122");
    expect(minusIds("5", 1000)).toBe("-995");
    expect(minusIds("42", 0)).toBe("42");
    expect(err(() => minusIds("1.5", 1)).kind).toBe("spec");
  });
});

describe("lookbackOf: how far back a pull starts, by the watermark column's type", () => {
  it("defaults: a timestamp none, a date one day, an integer 1,000 ids", () => {
    expect(lookbackOf("postgres", col("w", "timestamp with time zone"), {})).toEqual({ by: "seconds", n: 0 });
    expect(lookbackOf("postgres", col("w", "date"), {})).toEqual({ by: "seconds", n: 86_400 });
    expect(lookbackOf("postgres", col("w", "bigint"), {})).toEqual({ by: "ids", n: 1000 });
    expect(lookbackOf("oracle", col("w", "DATE"), {})).toEqual({ by: "seconds", n: 0 }); // Oracle's DATE holds a time of day
  });
  it("a date-only watermark looks back at least a day; seconds only for a date or time, ids only for an integer", () => {
    expect(lookbackOf("postgres", col("w", "date"), { seconds: 86_400 })).toEqual({ by: "seconds", n: 86_400 });
    expect(lookbackOf("postgres", col("w", "date"), { seconds: 3600 })).toEqual({
      problem: 'The watermark column "w" holds a date only, so the look back must be at least 1 day (86,400 seconds): a row added later on the same date with a smaller id would be skipped. Rows read again are stored once.',
      field: "lookback_seconds",
    });
    expect(lookbackOf("mssql", col("w", "int"), { seconds: 60 })).toEqual({ problem: 'The watermark column "w" is an integer (a sequence), so it looks back a number of ids, not seconds.', field: "lookback_seconds" });
    expect(lookbackOf("mssql", col("w", "int"), { ids: 0 })).toEqual({ by: "ids", n: 0 });
    expect(lookbackOf("postgres", col("w", "timestamp"), { ids: 10 })).toEqual({ problem: 'The watermark column "w" is a date or time, so it looks back in seconds, not ids.', field: "lookback_ids" });
  });
});

describe("nullProbeSql: the first row whose watermark or an id is NULL", () => {
  it("answers which column, one row at most, per dialect", () => {
    const k = [col("at", "datetime2"), col("ref", "varchar(10)")];
    expect(nullProbeSql("mssql", { query: "SELECT a.at, b.ref FROM a LEFT JOIN b ON b.k = a.k" }, k).sql).toBe(
      "SELECT CASE WHEN t.[at] IS NULL THEN 0 WHEN t.[ref] IS NULL THEN 1 END AS [i] FROM (SELECT a.at, b.ref FROM a LEFT JOIN b ON b.k = a.k) t "
      + "WHERE t.[at] IS NULL OR t.[ref] IS NULL ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 1 ROWS ONLY");
    expect(nullProbeSql("oracle", { table: "T" }, [col("AT", "DATE")]).sql).toBe(`SELECT CASE WHEN t."AT" IS NULL THEN 0 END AS "i" FROM "T" t WHERE t."AT" IS NULL FETCH FIRST 1 ROWS ONLY`);
  });
});

describe("ids whose database order is not their text order", () => {
  it("SQL Server text ids (a uniqueidentifier, a varchar under a SQL_* or _CI_ collation): ordered and compared as the bytes of their nvarchar text", () => {
    // a varchar column compared with an nvarchar parameter takes Unicode rules while its ORDER BY takes the SQL_*
    // collation's; a _CI_ collation makes 'a' = 'A', two texts the cursor tells apart; a uniqueidentifier orders by its
    // last bytes first. One expression on both sides, binary, is the same order and the same comparison
    for (const type of ["uniqueidentifier", "varchar(36)", "nvarchar(20)", "char(10)"]) {
      const k = [col("w", "datetime2"), col("g", type)];
      const b = rowsSql("mssql", { from: { table: "t" }, columns: k, keyset: { wm: k[0]!, ids: [k[1]!], cursor: { after: { wm: "2026-11-19T00:00:00.0000000", ids: ["6F9619FF-8B86-D011-B42D-00C04FC964FF"] } } }, limit: 5 });
      expect(b.sql).toContain(`OR ${MS("t.[g]")} > ${MS("@p2")}) ORDER BY t.[w], ${MS("t.[g]")} OFFSET`);
      expect(b.sql).toStartWith("SELECT CONVERT(varchar(27), CAST(t.[w] AS datetime2(7)), 126) AS [w], CAST(t.[g] AS nvarchar(max)) AS [g]"); // the text kept is the text compared
    }
    // a number id is compared as its own type, index usable
    const n = [col("w", "datetime2"), col("i", "bigint")];
    expect(rowsSql("mssql", { from: { table: "t" }, columns: n, keyset: { wm: n[0]!, ids: [n[1]!], cursor: null }, limit: 5 }).sql).toContain("ORDER BY t.[w], t.[i] OFFSET");
  });

  it("MySQL text ids: the column's collation (often _ci, PAD SPACE) would make two texts equal; ordered and compared as their utf8mb4 bytes", () => {
    const k = [col("w", "datetime(6)"), col("r", "varchar(20)")];
    const b = rowsSql("mysql", { from: { table: "t" }, columns: k, keyset: { wm: k[0]!, ids: [k[1]!], cursor: { after: { wm: "2026-11-19T00:00:00.000000", ids: ["a"] } } }, limit: 5 });
    expect(b.sql).toEndWith(`OR ${MY("t.`r`")} > ${MY("?")}) ORDER BY t.\`w\`, ${MY("t.`r`")} LIMIT 5`);
    expect(b.params).toEqual(["2026-11-19T00:00:00.000000", "2026-11-19T00:00:00.000000", "a"]);
  });

  it("Oracle text ids: ORDER BY follows the session's NLS_SORT and = / > its NLS_COMP; both pinned to binary on national-character text", () => {
    for (const type of ["VARCHAR2(20)", "NVARCHAR2(20)", "CHAR(10)"]) {
      const k = [col("W", "TIMESTAMP(6)"), col("R", type)];
      const b = rowsSql("oracle", { from: { table: "T" }, columns: k, keyset: { wm: k[0]!, ids: [k[1]!], cursor: { after: { wm: "2026-11-19T00:00:00.000000", ids: ["a"] } } }, limit: 5 });
      expect(b.sql).toEndWith(`OR ${ORA('t."R"')} > ${ORA(":p2")}) ORDER BY t."W", ${ORA('t."R"')} FETCH FIRST 5 ROWS ONLY`);
    }
  });

  it("PostgreSQL text ids keep the column: ORDER BY and > use the same (deterministic) collation", () => {
    const k = [col("w", "date"), col("r", "character varying(20)")];
    expect(rowsSql("postgres", { from: { table: "t" }, columns: k, keyset: { wm: k[0]!, ids: [k[1]!], cursor: { after: { wm: "2026-11-19", ids: ["a"] } } }, limit: 5 }).sql)
      .toEndWith('WHERE (t."w", t."r") > ($1, $2) ORDER BY t."w", t."r" LIMIT 5');
  });

  it("a binary id (Oracle RAW, MySQL binary(16), SQL Server varbinary, PostgreSQL bytea) is refused with how to read it as text", () => {
    const cases: [D, string, string][] = [
      ["oracle", "RAW(16)", 'RAWTOHEX("g") AS "g"'], ["mysql", "binary(16)", "HEX(`g`) AS `g`"], ["mssql", "varbinary(16)", "CONVERT(char(32), [g], 2) AS [g]"], ["postgres", "bytea", `encode("g", 'hex') AS "g"`],
    ];
    for (const [d, type, hint] of cases) {
      const w = col("w", d === "oracle" ? "TIMESTAMP(6)" : "date");
      const e = err(() => rowsSql(d, { from: { table: "t" }, columns: [w, col("g", type)], keyset: { wm: w, ids: [col("g", type)], cursor: null }, limit: 5 }));
      expect([d, e.kind, e.message]).toEqual([d, "spec",
        `The id column "g" is ${type}: its bytes sort in another order than the text a pull keeps of them. Pick another id column, or read it as text in your own SELECT (${hint}).`]);
    }
  });
});
