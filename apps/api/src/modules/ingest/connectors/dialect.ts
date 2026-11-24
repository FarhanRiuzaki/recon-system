// The SQL the source connectors send, per dialect (spec §7 "Konektor DB sumber", §8 "Pull watermark"). Pure: no driver.
// SQL sent to a bank's database, not ours, so it is written by hand here (boundaries.test.ts allowlists connectors/).
//
// - Values only as bound parameters: PostgreSQL $1, MySQL ?, SQL Server @p0, Oracle :p0, one per use (MySQL can't
//   name a parameter twice). The paging size is an integer literal, checked as one.
// - Identifiers only from the source's catalog (introspect), quoted per dialect; table names first pass DB_TABLE_NAME.
// - Every column comes back as text (spec: values reach coerce as strings; SQL NULL stays null). Date-times are
//   formatted by the database with all their digits (microseconds: S7), never through a JS Date; a time-zone-aware
//   value in UTC with "Z". The watermark is sent back in the same text form and parsed by the database.
// - Keyset (updated_at, ids…) > ($wm, $ids…): a row comparison on PostgreSQL, spelled out elsewhere (no row values in
//   SQL Server and Oracle); ordered by the source's own columns through the alias `t`, never by the text aliases (S7).
// - A custom SELECT (IT's) is one SELECT or WITH, wrapped as a subquery; `:business_date` becomes a date parameter.
import { DATE_LOOKBACK_MIN_SECONDS, DB_TABLE_NAME, type DbEngine, LOOKBACK_IDS_DEFAULT } from "@starterkit/shared/sources";
import { specError } from "./errors";

export type Dialect = DbEngine;
/** What decides a column's text form and how its watermark text is read back. */
export type Family = "tstz" | "ts" | "date" | "int" | "num" | "bool" | "text";
/**
 * A source column: its name and native type as the engine spells them; `nullable` null when the engine doesn't say.
 * From a table's catalog also `unique` (alone a primary key or unique key) and `indexed` (leads an index); a SELECT's
 * columns leave both null.
 */
export type Column = { name: string; type: string; nullable: boolean | null; unique?: boolean | null; indexed?: boolean | null };
/** A table (`schema.table` or `table`) or a custom SELECT; a snapshot SELECT takes `businessDate` for `:business_date`. */
export type From = { table: string } | { query: string; businessDate?: string };
/** Where a keyset pull resumes: after (watermark, ids…), from a watermark on (`>=`, the lookback start), or the start. */
export type Cursor = { after: { wm: string; ids: readonly string[] } } | { from: string } | null;
export type Built = { sql: string; params: (string | null)[] };

const QUOTE: Record<Dialect, [string, string]> = { postgres: ['"', '"'], oracle: ['"', '"'], mysql: ["`", "`"], mssql: ["[", "]"] };

/** `name` quoted for `d`, its closing quote doubled. */
export function quoteIdent(d: Dialect, name: string): string {
  const [o, c] = QUOTE[d];
  return o + name.replaceAll(c, c + c) + c;
}

/** `table` or `schema.table` split; anything else is a spec error. */
export function tableName(table: string): { schema: string | null; name: string } {
  if (!DB_TABLE_NAME.test(table)) throw specError(`"${table.slice(0, 64)}" is not a table name: use table or schema.table, letters, digits and _ only.`);
  const [a, b] = table.split(".");
  return b === undefined ? { schema: null, name: a! } : { schema: a!, name: b };
}

const FAMILIES: Record<Dialect, [Family, RegExp][]> = {
  postgres: [["tstz", /^timestamp.*with time zone$/], ["ts", /^timestamp/], ["date", /^date$/], ["int", /^(smallint|integer|bigint)$/], ["num", /^(numeric|decimal|real|double precision)/], ["bool", /^boolean$/]],
  mysql: [["tstz", /^timestamp/], ["ts", /^datetime/], ["date", /^(date|newdate)$/], ["int", /^(tiny|short|long|longlong|int24|tinyint|smallint|mediumint|int|integer|bigint)\b/], ["num", /^(decimal|newdecimal|numeric|float|double)\b/]],
  mssql: [["tstz", /^datetimeoffset/], ["ts", /^(datetime2|datetime|smalldatetime)\b/], ["date", /^date$/], ["int", /^(tinyint|smallint|int|bigint)$/], ["num", /^(decimal|numeric|money|smallmoney|float|real)\b/], ["bool", /^bit$/]],
  // Oracle's DATE holds a time of day: a timestamp without fraction
  oracle: [["tstz", /^timestamp.*time zone$/], ["ts", /^(timestamp|date$)/], ["int", /^(number\(\d+,0\)|integer)$/], ["num", /^(number|float|binary_)/]],
};

/** The family of native type `type` on `d`; anything unlisted is text. */
export function familyOf(d: Dialect, type: string): Family {
  const t = type.trim().toLowerCase();
  return FAMILIES[d].find(([, re]) => re.test(t))?.[0] ?? "text";
}

/** IT's SELECT trimmed, or a spec error: one statement (no `;`), no comments, starting with SELECT or WITH. */
export function checkSelect(d: Dialect, query: string): string {
  const q = query.trim();
  if (q.includes(";")) throw specError("The query must be one SELECT, without ';'.");
  if (/--|\/\*/.test(q) || (d === "mysql" && q.includes("#"))) throw specError("The query must have no comments (-- or /* */ or #).");
  if (!/^(select|with)\b/i.test(q)) throw specError("The query must start with SELECT or WITH.");
  if (d === "mssql" && /^with\b/i.test(q)) throw specError("SQL Server can't run a WITH query as a subquery: write it as one SELECT.");
  return q;
}

/** A text watermark `seconds` earlier, its fraction digits and form kept ("…T00:00:30.123456Z" − 60 → "…T23:59:30.123456Z"). */
export function minusSeconds(wm: string, seconds: number): string {
  const m = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}:\d{2})(\.\d+)?)?(Z?)$/.exec(wm);
  if (!m) throw specError("The watermark is not a date or time this connector wrote.");
  const ms = Date.parse(`${m[1]}T${m[2] ?? "00:00:00"}Z`) - seconds * 1000;
  const iso = new Date(ms).toISOString();
  if (m[2] === undefined) return iso.slice(0, 10);
  return `${iso.slice(0, 19)}${m[3] ?? ""}${m[4]}`;
}

/** Binds values for one statement: each call adds a parameter and answers its placeholder. */
function binder(d: Dialect) {
  const params: (string | null)[] = [];
  const p = (v: string | null) => {
    params.push(v);
    const i = params.length;
    return d === "postgres" ? `$${i}` : d === "mysql" ? "?" : d === "mssql" ? `@p${i - 1}` : `:p${i - 1}`;
  };
  return { params, p };
}

const PG_TS = `'YYYY-MM-DD"T"HH24:MI:SS.US'`;
const MY_TS = "'%Y-%m-%dT%H:%i:%s.%f'";
const ORA_TS = `'YYYY-MM-DD"T"HH24:MI:SS.FF6'`;
const ORA_TSZ = `'YYYY-MM-DD"T"HH24:MI:SS.FF6"Z"'`;
const ORA_DATE = `'YYYY-MM-DD"T"HH24:MI:SS'`;
const isOraDate = (c: Column) => c.type.trim().toUpperCase() === "DATE";

/** `ref` (a column of `t`) as text in the form this module reads. */
function asText(d: Dialect, c: Column, ref: string): string {
  const f = familyOf(d, c.type);
  switch (d) {
    case "postgres":
      return f === "tstz" ? `to_char(${ref} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`
        : f === "ts" ? `to_char(${ref}, ${PG_TS})` : f === "date" ? `to_char(${ref}, 'YYYY-MM-DD')` : `${ref}::text`;
    case "mysql": // the session's time_zone is UTC (mysql.ts), so a TIMESTAMP reads in UTC
      return f === "tstz" ? `DATE_FORMAT(${ref}, '%Y-%m-%dT%H:%i:%s.%fZ')` : f === "ts" ? `DATE_FORMAT(${ref}, ${MY_TS})`
        : f === "date" ? `DATE_FORMAT(${ref}, '%Y-%m-%d')` : `CAST(${ref} AS CHAR)`;
    case "mssql":
      // money keeps its 4 decimals (style 2), float/real all 17 digits (style 3): a plain CAST rounds both
      return f === "tstz" ? `CONVERT(varchar(34), SWITCHOFFSET(${ref}, '+00:00'), 127)` : f === "ts" ? `CONVERT(varchar(27), CAST(${ref} AS datetime2(7)), 126)`
        : f === "date" ? `CONVERT(varchar(10), ${ref}, 23)` : /^(small)?money$/i.test(c.type.trim()) ? `CONVERT(nvarchar(max), ${ref}, 2)`
          : /^(float|real)\b/i.test(c.type.trim()) ? `CONVERT(nvarchar(max), ${ref}, 3)` : `CAST(${ref} AS nvarchar(max))`;
    case "oracle":
      return f === "tstz" ? `TO_CHAR(SYS_EXTRACT_UTC(${ref}), ${ORA_TSZ})` : f === "ts" ? `TO_CHAR(${ref}, ${isOraDate(c) ? ORA_DATE : ORA_TS})`
        : f === "int" || f === "num" ? `TO_CHAR(${ref}, 'TM9', 'NLS_NUMERIC_CHARACTERS=''.,''')` : ref;
  }
}

/** Placeholder `ph` holding text of column `c` (as asText wrote it) read back as the column's type. */
function fromText(d: Dialect, c: Column, ph: string): string {
  const f = familyOf(d, c.type);
  switch (d) {
    case "postgres": return ph; // an untyped parameter takes the column's type
    case "mysql":
      return f === "tstz" ? `STR_TO_DATE(${ph}, '%Y-%m-%dT%H:%i:%s.%fZ')` : f === "ts" ? `STR_TO_DATE(${ph}, ${MY_TS})` : f === "date" ? `STR_TO_DATE(${ph}, '%Y-%m-%d')`
        : f === "int" ? `CAST(${ph} AS DECIMAL(65,0))` : f === "num" ? `CAST(${ph} AS DECIMAL(65,30))` : ph;
    case "mssql":
      // back to the column's own type: a datetime (1/300 s) compared with its text as datetime2(7) is never equal to it.
      // A string parses into datetime/smalldatetime with at most 3 fraction digits (Msg 241 on the 7 asText writes), so
      // those go through datetime2(7), which rounds to the same 1/300 s tick (or minute)
      return f === "tstz" || f === "ts" ? mssqlTemporalFrom(ph, mssqlTemporal(c.type, f)) : f === "date" ? `CAST(${ph} AS date)`
        : f === "int" ? `CAST(${ph} AS bigint)` : f === "num" ? `CAST(${ph} AS decimal(38,10))` : ph;
    case "oracle":
      return f === "tstz" ? `FROM_TZ(TO_TIMESTAMP(${ph}, ${ORA_TSZ}), 'UTC')` : f === "ts" ? (isOraDate(c) ? `TO_DATE(${ph}, ${ORA_DATE})` : `TO_TIMESTAMP(${ph}, ${ORA_TS})`)
        : f === "int" || f === "num" ? `TO_NUMBER(${ph})` : ph;
  }
}

/** A SQL Server date-time type as declared (only these spellings pass), else the family's widest. */
const mssqlTemporal = (type: string, f: Family) => {
  const t = type.trim().toLowerCase();
  return /^(datetime|smalldatetime|datetime2(\([0-7]\))?|datetimeoffset(\([0-7]\))?)$/.test(t) ? t : f === "tstz" ? "datetimeoffset(7)" : "datetime2(7)";
};

const mssqlTemporalFrom = (ph: string, type: string) =>
  (type === "datetime" || type === "smalldatetime" ? `CAST(CAST(${ph} AS datetime2(7)) AS ${type})` : `CAST(${ph} AS ${type})`);

/** A date parameter for `:business_date`. */
const dateParam = (d: Dialect, ph: string) => (d === "oracle" ? `TO_DATE(${ph}, 'YYYY-MM-DD')` : `CAST(${ph} AS ${d === "mysql" ? "DATE" : "date"})`);

/** The FROM item: a quoted table, or IT's SELECT in parentheses with `:business_date` bound. */
function fromSql(d: Dialect, from: From, p: (v: string | null) => string): string {
  if ("table" in from) {
    const { schema, name } = tableName(from.table);
    return schema === null ? quoteIdent(d, name) : `${quoteIdent(d, schema)}.${quoteIdent(d, name)}`;
  }
  const q = checkSelect(d, from.query);
  const date = from.businessDate;
  return `(${date === undefined ? q : q.replace(/(?<!:):business_date\b/g, () => dateParam(d, p(date)))})`;
}

/**
 * The catalog query for a table's columns, in order: name, native type, nullable ('YES'/'Y' or not), unique ('YES' when
 * the column alone is a primary key or a unique key; a partial index doesn't count) and indexed ('YES' when it leads an
 * index). Oracle reads unique from P/U constraints only (a unique index without a constraint is not seen).
 */
export function catalogSql(d: Dialect, table: string): Built {
  const { schema, name } = tableName(table);
  const { params, p } = binder(d);
  const s = p(schema), n = p(name);
  const as = (x: string) => quoteIdent(d, x);
  const yes = (cond: string) => `CASE WHEN ${cond} THEN 'YES' ELSE 'NO' END`;
  const sql = {
    postgres: `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS nullable, `
      + `${yes("EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisunique AND i.indnkeyatts = 1 AND i.indkey[0] = a.attnum AND i.indpred IS NULL)")} AS "unique", `
      + `${yes("EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indkey[0] = a.attnum)")} AS indexed `
      + `FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace `
      + `WHERE ns.nspname = coalesce(${s}, current_schema()) AND c.relname = ${n} AND c.relkind IN ('r', 'v', 'm', 'p', 'f') `
      + `AND has_schema_privilege(ns.oid, 'USAGE') AND has_table_privilege(c.oid, 'SELECT') AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
    // COLUMN_KEY: PRI = in the primary key, UNI = alone a unique key, MUL = leads a non-unique (or multi-column) index
    mysql: `SELECT COLUMN_NAME AS ${as("name")}, COLUMN_TYPE AS ${as("type")}, IS_NULLABLE AS ${as("nullable")}, `
      + `${yes("COLUMN_KEY = 'UNI' OR (COLUMN_KEY = 'PRI' AND (SELECT COUNT(*) FROM information_schema.COLUMNS k WHERE k.TABLE_SCHEMA = c.TABLE_SCHEMA AND k.TABLE_NAME = c.TABLE_NAME AND k.COLUMN_KEY = 'PRI') = 1)")} AS ${as("unique")}, `
      + `${yes("COLUMN_KEY <> ''")} AS ${as("indexed")} FROM information_schema.COLUMNS c `
      + `WHERE TABLE_SCHEMA = COALESCE(${s}, DATABASE()) AND TABLE_NAME = ${n} ORDER BY ORDINAL_POSITION`,
    mssql: `SELECT COLUMN_NAME AS [name], CASE WHEN DATA_TYPE IN ('datetime2', 'datetimeoffset') THEN DATA_TYPE + '(' + CAST(DATETIME_PRECISION AS varchar(1)) + ')' `
      + `WHEN DATA_TYPE IN ('decimal', 'numeric') THEN DATA_TYPE + '(' + CAST(NUMERIC_PRECISION AS varchar(3)) + ',' + CAST(NUMERIC_SCALE AS varchar(3)) + ')' `
      + `WHEN CHARACTER_MAXIMUM_LENGTH = -1 THEN DATA_TYPE + '(max)' WHEN CHARACTER_MAXIMUM_LENGTH IS NOT NULL THEN DATA_TYPE + '(' + CAST(CHARACTER_MAXIMUM_LENGTH AS varchar(10)) + ')' `
      + `ELSE DATA_TYPE END AS [type], IS_NULLABLE AS [nullable], `
      + `${yes("EXISTS (SELECT 1 FROM sys.indexes i JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id WHERE i.object_id = OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME)) AND i.is_unique = 1 AND i.has_filter = 0 AND ic.key_ordinal = 1 AND COL_NAME(ic.object_id, ic.column_id) = c.COLUMN_NAME AND (SELECT COUNT(*) FROM sys.index_columns k WHERE k.object_id = i.object_id AND k.index_id = i.index_id AND k.key_ordinal > 0) = 1)")} AS [unique], `
      + `${yes("EXISTS (SELECT 1 FROM sys.index_columns ic WHERE ic.object_id = OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME)) AND ic.key_ordinal = 1 AND COL_NAME(ic.object_id, ic.column_id) = c.COLUMN_NAME)")} AS [indexed] `
      + `FROM INFORMATION_SCHEMA.COLUMNS c WHERE TABLE_SCHEMA = COALESCE(${s}, SCHEMA_NAME()) AND TABLE_NAME = ${n} ORDER BY ORDINAL_POSITION`,
    oracle: `SELECT COLUMN_NAME AS "name", DATA_TYPE || CASE WHEN DATA_TYPE = 'NUMBER' AND DATA_PRECISION IS NOT NULL THEN '(' || DATA_PRECISION || ',' || DATA_SCALE || ')' END AS "type", NULLABLE AS "nullable", `
      + `${yes("EXISTS (SELECT 1 FROM ALL_CONSTRAINTS k JOIN ALL_CONS_COLUMNS cc ON cc.OWNER = k.OWNER AND cc.CONSTRAINT_NAME = k.CONSTRAINT_NAME WHERE k.OWNER = c.OWNER AND k.TABLE_NAME = c.TABLE_NAME AND k.CONSTRAINT_TYPE IN ('P', 'U') AND cc.COLUMN_NAME = c.COLUMN_NAME AND (SELECT COUNT(*) FROM ALL_CONS_COLUMNS x WHERE x.OWNER = k.OWNER AND x.CONSTRAINT_NAME = k.CONSTRAINT_NAME) = 1)")} AS "unique", `
      + `${yes("EXISTS (SELECT 1 FROM ALL_IND_COLUMNS ic WHERE ic.TABLE_OWNER = c.OWNER AND ic.TABLE_NAME = c.TABLE_NAME AND ic.COLUMN_NAME = c.COLUMN_NAME AND ic.COLUMN_POSITION = 1)")} AS "indexed" `
      + `FROM ALL_TAB_COLUMNS c WHERE OWNER = COALESCE(${s}, USER) AND TABLE_NAME = ${n} ORDER BY COLUMN_ID`,
  }[d];
  return { sql, params };
}

// The source's catalog for the wizard's pickers (REC-F2a): databases, tables and views, the server's version. Fixed SQL
// per dialect, every value bound, results capped; only what this login may open or SELECT.

/** The database a test or a list connects to when none is typed (Oracle needs its service name: null). */
export const DEFAULT_DATABASE: Record<Dialect, string | null> = { postgres: "postgres", mssql: "master", mysql: "", oracle: null };
/** At most this many databases (Oracle: schemas) are listed; one more is read to tell that the list was cut. */
export const CATALOG_DATABASES_MAX = 500;
/** Tables per page of the table list. */
export const CATALOG_TABLES_PAGE = 50;
/** A table count stops here ("10,000+"). */
export const CATALOG_COUNT_CAP = 10_000;
/** A table or view in the list: its schema (MySQL: the database), name, kind and number of columns. */
export type CatalogTable = { schema: string; name: string; kind: "table" | "view"; columns: number };
export type CatalogFilter = { schema?: string; q?: string };

/** The first `n` rows, in `d`'s spelling; SQL Server needs an ORDER BY for it, so one that orders nothing is added. */
const firstRows = (d: Dialect, n: number, ordered: boolean) =>
  (d === "mssql" ? `${ordered ? "" : " ORDER BY (SELECT NULL)"} OFFSET 0 ROWS FETCH NEXT ${n} ROWS ONLY` : d === "oracle" ? ` FETCH FIRST ${n} ROWS ONLY` : ` LIMIT ${n}`);
/** Search text as a contains-pattern for LIKE … ESCAPE '!', lower-cased ('[' is special on SQL Server). */
export const likeContains = (q: string) => `%${q.toLowerCase().replace(/[!%_[]/g, "!$&")}%`;

/**
 * The tables and views this login can SELECT, as `o(s, n, k)` plus the engine's key for the column count: PostgreSQL the
 * current database's schemas (system ones left out, USAGE on the schema and SELECT on the table checked); MySQL the
 * connected database (information_schema lists only what the login holds a privilege on); SQL Server the current
 * database, HAS_PERMS_BY_NAME … SELECT; Oracle ALL_TABLES and ALL_VIEWS outside the Oracle-maintained schemas.
 */
const OBJECTS: Record<Dialect, string> = {
  postgres: `SELECT c.oid AS id, ns.nspname AS s, c.relname AS n, CASE WHEN c.relkind IN ('v', 'm') THEN 'view' ELSE 'table' END AS k `
    + `FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f') AND NOT c.relispartition `
    + `AND ns.nspname <> 'information_schema' AND ns.nspname NOT LIKE 'pg!_%' ESCAPE '!' AND has_schema_privilege(ns.oid, 'USAGE') AND has_table_privilege(c.oid, 'SELECT')`,
  mysql: "SELECT TABLE_SCHEMA AS s, TABLE_NAME AS n, CASE WHEN TABLE_TYPE = 'VIEW' THEN 'view' ELSE 'table' END AS k FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()",
  mssql: "SELECT x.object_id AS id, sc.name AS s, x.name AS n, CASE WHEN x.type = 'V' THEN 'view' ELSE 'table' END AS k FROM sys.objects x JOIN sys.schemas sc ON sc.schema_id = x.schema_id "
    + "WHERE x.type IN ('U', 'V') AND x.is_ms_shipped = 0 AND HAS_PERMS_BY_NAME(QUOTENAME(sc.name) + '.' + QUOTENAME(x.name), 'OBJECT', 'SELECT') = 1",
  oracle: "SELECT u.s, u.n, u.k FROM (SELECT OWNER AS s, TABLE_NAME AS n, 'table' AS k FROM ALL_TABLES WHERE NESTED = 'NO' AND SECONDARY = 'N' AND DROPPED = 'NO' "
    + "UNION ALL SELECT OWNER AS s, VIEW_NAME AS n, 'view' AS k FROM ALL_VIEWS) u WHERE u.s NOT IN (SELECT USERNAME FROM ALL_USERS WHERE ORACLE_MAINTAINED = 'Y')",
};
/** The column count of the object `o` names, per dialect. */
const COLUMN_COUNT: Record<Dialect, string> = {
  postgres: "(SELECT count(*)::int FROM pg_attribute a WHERE a.attrelid = o.id AND a.attnum > 0 AND NOT a.attisdropped)",
  mysql: "(SELECT COUNT(*) FROM information_schema.COLUMNS c WHERE c.TABLE_SCHEMA = o.s AND c.TABLE_NAME = o.n)",
  mssql: "(SELECT COUNT(*) FROM sys.columns c WHERE c.object_id = o.id)",
  oracle: "(SELECT COUNT(*) FROM ALL_TAB_COLUMNS c WHERE c.OWNER = o.s AND c.TABLE_NAME = o.n)",
};

/** `FROM (objects) o WHERE …` for `f` (one schema, and/or `q` contained in the name or the schema, any case) and `more`. */
function objectsWhere(d: Dialect, f: CatalogFilter, p: (v: string | null) => string, more: (() => string)[] = []): string {
  const where: string[] = [];
  if (f.schema !== undefined) where.push(`o.s = ${p(f.schema)}`);
  if (f.q?.trim()) {
    const like = likeContains(f.q.trim());
    where.push(`(LOWER(o.n) LIKE ${p(like)} ESCAPE '!' OR LOWER(o.s) LIKE ${p(like)} ESCAPE '!')`);
  }
  where.push(...more.map((m) => m()));
  return `FROM (${OBJECTS[d]}) o${where.length ? ` WHERE ${where.join(" AND ")}` : ""}`;
}

/** One page of the tables and views (`limit` rows, ordered by schema and name), after (`after.schema`, `after.name`). */
export function tablesSql(d: Dialect, o: CatalogFilter & { after?: { schema: string; name: string }; limit: number }): Built {
  if (!Number.isSafeInteger(o.limit) || o.limit < 1) throw new Error("limit must be a positive integer");
  const { params, p } = binder(d);
  const as = (x: string) => quoteIdent(d, x);
  const a = o.after;
  // no row comparison outside PostgreSQL; parameters are bound in the order they appear
  const keyset = !a ? [] : [() => (d === "postgres" ? `(o.s, o.n) > (${p(a.schema)}, ${p(a.name)})` : `(o.s > ${p(a.schema)} OR (o.s = ${p(a.schema)} AND o.n > ${p(a.name)}))`)];
  const sql = `SELECT o.s AS ${as("schema")}, o.n AS ${as("name")}, o.k AS ${as("kind")}, ${COLUMN_COUNT[d]} AS ${as("columns")} ${objectsWhere(d, o, p, keyset)}`
    + ` ORDER BY o.s, o.n${firstRows(d, o.limit, true)}`;
  return { sql, params };
}

/** How many tables and views `f` matches, counted up to `cap` (a count of `cap` means "cap or more"). */
export function tableCountSql(d: Dialect, f: CatalogFilter, cap: number): Built {
  const { params, p } = binder(d);
  return { sql: `SELECT COUNT(*) AS ${quoteIdent(d, "n")} FROM (SELECT 1 AS one ${objectsWhere(d, f, p)}${firstRows(d, cap, false)}) x`, params };
}

/** The databases this login can open (Oracle: the schemas it can read a table or view in), CATALOG_DATABASES_MAX + 1 at most. */
export function databasesSql(d: Dialect): string {
  const n = CATALOG_DATABASES_MAX + 1;
  return {
    postgres: `SELECT datname AS name FROM pg_database WHERE datallowconn AND NOT datistemplate AND has_database_privilege(datname, 'CONNECT') ORDER BY datname LIMIT ${n}`,
    mysql: `SELECT SCHEMA_NAME AS \`name\` FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('information_schema', 'mysql', 'performance_schema', 'sys') ORDER BY SCHEMA_NAME LIMIT ${n}`,
    mssql: `SELECT name AS [name] FROM sys.databases WHERE database_id > 4 AND state = 0 AND HAS_DBACCESS(name) = 1 ORDER BY name OFFSET 0 ROWS FETCH NEXT ${n} ROWS ONLY`,
    oracle: `SELECT DISTINCT o.s AS "name" FROM (${OBJECTS.oracle}) o ORDER BY 1 FETCH FIRST ${n} ROWS ONLY`,
  }[d];
}

/** The server's version, the login it signed in as and the database (Oracle: its name) the session is in. */
export const serverSql = (d: Dialect): string => ({
  postgres: `SELECT current_setting('server_version') AS version, current_user AS "user", current_database() AS database`,
  mysql: "SELECT VERSION() AS `version`, SUBSTRING_INDEX(CURRENT_USER(), '@', 1) AS `user`, DATABASE() AS `database`",
  mssql: "SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS [version], SUSER_SNAME() AS [user], DB_NAME() AS [database]",
  oracle: `SELECT (SELECT MAX(VERSION) FROM PRODUCT_COMPONENT_VERSION WHERE PRODUCT LIKE 'Oracle%') AS "version", USER AS "user", SYS_CONTEXT('USERENV', 'DB_NAME') AS "database" FROM DUAL`,
}[d]);

/** A query with the shape of `from`'s result and no rows: its columns come from the driver's result metadata. */
export function describeSql(d: Dialect, from: From): Built {
  const { params, p } = binder(d);
  return { sql: `SELECT * FROM ${fromSql(d, from, p)} t WHERE 1 = 0`, params };
}

/** The connection check. */
export const pingSql = (d: Dialect) => (d === "oracle" ? "SELECT 1 FROM DUAL" : "SELECT 1");

const WM_FAMILIES: Family[] = ["tstz", "ts", "date", "int"];
const ID_FAMILIES: Family[] = ["int", "num", "text"];

/** How a pull looks back from its last watermark: seconds for a date or time, ids for an integer (spec's values). */
export type Lookback = { seconds?: number; ids?: number };
/**
 * The look back watermark column `wm` takes under the spec's `l` (left out: a timestamp none, a date-only column one day,
 * an integer LOOKBACK_IDS_DEFAULT ids), or why `l` doesn't fit the column: seconds on an integer, ids on a date or time,
 * or under a day on a date-only column (a row added later that day with a smaller id would be skipped).
 */
export function lookbackOf(d: Dialect, wm: Column, l: Lookback): { by: "seconds" | "ids"; n: number } | { problem: string; field: "lookback_seconds" | "lookback_ids" } {
  const f = familyOf(d, wm.type);
  if (f === "int") {
    if (l.seconds !== undefined) return { problem: `The watermark column "${wm.name}" is an integer (a sequence), so it looks back a number of ids, not seconds.`, field: "lookback_seconds" };
    return { by: "ids", n: l.ids ?? LOOKBACK_IDS_DEFAULT };
  }
  if (l.ids !== undefined) return { problem: `The watermark column "${wm.name}" is a date or time, so it looks back in seconds, not ids.`, field: "lookback_ids" };
  if (f === "date" && l.seconds !== undefined && l.seconds < DATE_LOOKBACK_MIN_SECONDS) {
    return {
      problem: `The watermark column "${wm.name}" holds a date only, so the look back must be at least 1 day (86,400 seconds): a row added later on the same date with a smaller id would be skipped. Rows read again are stored once.`,
      field: "lookback_seconds",
    };
  }
  return { by: "seconds", n: l.seconds ?? (f === "date" ? DATE_LOOKBACK_MIN_SECONDS : 0) };
}

/** An integer watermark's text `n` ids earlier, exact at any size (BigInt, never a JS float). */
export function minusIds(wm: string, n: number): string {
  if (!/^-?\d+$/.test(wm.trim())) throw specError("The watermark is not an integer this connector wrote.");
  return (BigInt(wm.trim()) - BigInt(n)).toString();
}

/** Binary types: their bytes sort in another order than any text kept of them; the hex text to read instead. */
const BINARY: Record<Dialect, [RegExp, (n: string) => string]> = {
  postgres: [/^bytea$/, (n) => `encode(${n}, 'hex') AS ${n}`],
  mysql: [/^(binary|varbinary|tinyblob|blob|mediumblob|longblob)\b/, (n) => `HEX(${n}) AS ${n}`],
  mssql: [/^(binary|varbinary|image|timestamp|rowversion)\b/, (n) => `CONVERT(char(32), ${n}, 2) AS ${n}`],
  oracle: [/^(raw|long raw|blob)\b/, (n) => `RAWTOHEX(${n}) AS ${n}`],
};

/**
 * An id column as the keyset orders and compares it. SQL Server orders a uniqueidentifier by its last bytes first, not
 * as its text: ordered and compared as that text, binary collation, so the database's order is the order of the text
 * a pull keeps (an index on it is not used).
 */
const idExpr = (d: Dialect, c: Column, ref: string) =>
  (d === "mssql" && /^uniqueidentifier$/i.test(c.type.trim()) ? `CONVERT(char(36), ${ref}) COLLATE Latin1_General_BIN2` : ref);

/**
 * SELECT `columns` (as text) FROM `from` [WHERE keyset] [ORDER BY watermark, ids…] [first `limit` rows]. Without a
 * keyset (a sample, a snapshot) there is no predicate and no order. `columns` must come from the source's catalog.
 */
export function rowsSql(d: Dialect, o: { from: From; columns: Column[]; keyset?: { wm: Column; ids: Column[]; cursor: Cursor }; limit?: number }): Built {
  const { params, p } = binder(d);
  const ref = (c: Column) => `t.${quoteIdent(d, c.name)}`;
  const cols = o.columns.map((c) => `${asText(d, c, ref(c))} AS ${quoteIdent(d, c.name)}`).join(", ");
  let sql = `SELECT ${cols} FROM ${fromSql(d, o.from, p)} t`;
  let ordered = false;
  if (o.keyset) {
    const { wm, ids, cursor } = o.keyset;
    if (!WM_FAMILIES.includes(familyOf(d, wm.type))) throw specError(`The watermark column "${wm.name}" is ${wm.type}; it must be a date, a timestamp or an integer.`);
    if (!ids.length) throw new Error("a keyset needs an id column");
    for (const id of ids) {
      if (!ID_FAMILIES.includes(familyOf(d, id.type))) throw specError(`The id column "${id.name}" is ${id.type}; it must be a number or text.`);
      const [binary, hex] = BINARY[d];
      if (binary.test(id.type.trim().toLowerCase())) {
        throw specError(`The id column "${id.name}" is ${id.type}: its bytes sort in another order than the text a pull keeps of them. Pick another id column, or read it as text in your own SELECT (${hex(id.name)}).`);
      }
    }
    const w = ref(wm), is = ids.map((c) => idExpr(d, c, ref(c)));
    if (!cursor) sql += ` WHERE ${w} IS NOT NULL`; // keyset can't place a NULL watermark: such rows are never pulled
    else if ("from" in cursor) sql += ` WHERE ${w} >= ${fromText(d, wm, p(cursor.from))}`;
    else {
      const { wm: v, ids: ks } = cursor.after;
      if (ks.length !== ids.length) throw new Error("the cursor has another number of ids than the keyset");
      // an id compared as text (idExpr) takes the parameter as text; else the parameter is read back as the column's type
      const val = (j: number) => (is[j] === ref(ids[j]!) ? fromText(d, ids[j]!, p(ks[j]!)) : p(ks[j]!));
      if (d === "postgres") sql += ` WHERE (${w}, ${is.join(", ")}) > (${p(v)}, ${ks.map((_, j) => val(j)).join(", ")})`;
      else {
        // no row comparison here: spelled out as a range on the watermark (>=) that an index on (watermark, ids) seeks,
        // and the tie on it broken by the ids in order (the first greater, or equal and the next greater, …); the bare
        // OR form (w > a OR (w = a AND id > b)) may scan in MySQL, SQL Server, Oracle
        const ge = fromText(d, wm, p(v)), gt = fromText(d, wm, p(v)); // bound first: parameters go in the order they appear
        const ties = is.map((e, j) => {
          const eq = is.slice(0, j).map((x, m) => `${x} = ${val(m)}`);
          const after = `${e} > ${val(j)}`;
          return eq.length ? `(${[...eq, after].join(" AND ")})` : after;
        });
        sql += ` WHERE ${w} >= ${ge} AND (${w} > ${gt} OR ${ties.join(" OR ")})`;
      }
    }
    sql += ` ORDER BY ${w}, ${is.join(", ")}`;
    ordered = true;
  }
  if (o.limit !== undefined) {
    if (!Number.isSafeInteger(o.limit) || o.limit < 1) throw new Error("limit must be a positive integer");
    sql += d === "mssql" ? `${ordered ? "" : " ORDER BY (SELECT NULL)"} OFFSET 0 ROWS FETCH NEXT ${o.limit} ROWS ONLY`
      : d === "oracle" ? ` FETCH FIRST ${o.limit} ROWS ONLY` : ` LIMIT ${o.limit}`;
  }
  return { sql, params };
}
