// The SQL the source connectors send, per dialect (spec §7 "Konektor DB sumber", §8 "Pull watermark"). Pure: no driver.
// SQL sent to a bank's database, not ours, so it is written by hand here (boundaries.test.ts allowlists connectors/).
//
// - Values only as bound parameters: PostgreSQL $1, MySQL ?, SQL Server @p0, Oracle :p0, one per use (MySQL can't
//   name a parameter twice). The paging size is an integer literal, checked as one.
// - Identifiers only from the source's catalog (introspect), quoted per dialect; table names first pass DB_TABLE_NAME.
// - Every column comes back as text (spec: values reach coerce as strings; SQL NULL stays null). Date-times are
//   formatted by the database with all their digits (microseconds: S7), never through a JS Date; a time-zone-aware
//   value in UTC with "Z". The watermark is sent back in the same text form and parsed by the database.
// - Keyset (updated_at, id) > ($wm, $id): a row comparison on PostgreSQL, spelled out elsewhere (no row values in
//   SQL Server and Oracle); ordered by the source's own columns through the alias `t`, never by the text aliases (S7).
// - A custom SELECT (IT's) is one SELECT or WITH, wrapped as a subquery; `:business_date` becomes a date parameter.
import { DB_TABLE_NAME, type DbEngine } from "@starterkit/shared/sources";
import { specError } from "./errors";

export type Dialect = DbEngine;
/** What decides a column's text form and how its watermark text is read back. */
export type Family = "tstz" | "ts" | "date" | "int" | "num" | "bool" | "text";
/** A source column: its name and native type as the engine spells them; `nullable` null when the engine doesn't say. */
export type Column = { name: string; type: string; nullable: boolean | null };
/** A table (`schema.table` or `table`) or a custom SELECT; a snapshot SELECT takes `businessDate` for `:business_date`. */
export type From = { table: string } | { query: string; businessDate?: string };
/** Where a keyset pull resumes: after (watermark, id), from a watermark on (`>=`, the lookback start), or the start. */
export type Cursor = { after: { wm: string; id: string } } | { from: string } | null;
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

/** The catalog query for a table's columns, in order: name, native type, nullable ('YES'/'Y' or not). */
export function catalogSql(d: Dialect, table: string): Built {
  const { schema, name } = tableName(table);
  const { params, p } = binder(d);
  const s = p(schema), n = p(name);
  const as = (x: string) => quoteIdent(d, x);
  const sql = {
    postgres: `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END AS nullable `
      + `FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace `
      + `WHERE ns.nspname = coalesce(${s}, current_schema()) AND c.relname = ${n} AND c.relkind IN ('r', 'v', 'm', 'p', 'f') AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`,
    mysql: `SELECT COLUMN_NAME AS ${as("name")}, COLUMN_TYPE AS ${as("type")}, IS_NULLABLE AS ${as("nullable")} FROM information_schema.COLUMNS `
      + `WHERE TABLE_SCHEMA = COALESCE(${s}, DATABASE()) AND TABLE_NAME = ${n} ORDER BY ORDINAL_POSITION`,
    mssql: `SELECT COLUMN_NAME AS [name], CASE WHEN DATA_TYPE IN ('datetime2', 'datetimeoffset') THEN DATA_TYPE + '(' + CAST(DATETIME_PRECISION AS varchar(1)) + ')' `
      + `WHEN DATA_TYPE IN ('decimal', 'numeric') THEN DATA_TYPE + '(' + CAST(NUMERIC_PRECISION AS varchar(3)) + ',' + CAST(NUMERIC_SCALE AS varchar(3)) + ')' `
      + `WHEN CHARACTER_MAXIMUM_LENGTH = -1 THEN DATA_TYPE + '(max)' WHEN CHARACTER_MAXIMUM_LENGTH IS NOT NULL THEN DATA_TYPE + '(' + CAST(CHARACTER_MAXIMUM_LENGTH AS varchar(10)) + ')' `
      + `ELSE DATA_TYPE END AS [type], IS_NULLABLE AS [nullable] FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = COALESCE(${s}, SCHEMA_NAME()) AND TABLE_NAME = ${n} ORDER BY ORDINAL_POSITION`,
    oracle: `SELECT COLUMN_NAME AS "name", DATA_TYPE || CASE WHEN DATA_TYPE = 'NUMBER' AND DATA_PRECISION IS NOT NULL THEN '(' || DATA_PRECISION || ',' || DATA_SCALE || ')' END AS "type", `
      + `NULLABLE AS "nullable" FROM ALL_TAB_COLUMNS WHERE OWNER = COALESCE(${s}, USER) AND TABLE_NAME = ${n} ORDER BY COLUMN_ID`,
  }[d];
  return { sql, params };
}

/** A query with the shape of `from`'s result and no rows: its columns come from the driver's result metadata. */
export function describeSql(d: Dialect, from: From): Built {
  const { params, p } = binder(d);
  return { sql: `SELECT * FROM ${fromSql(d, from, p)} t WHERE 1 = 0`, params };
}

/** The connection check. */
export const pingSql = (d: Dialect) => (d === "oracle" ? "SELECT 1 FROM DUAL" : "SELECT 1");

const WM_FAMILIES: Family[] = ["tstz", "ts", "date"];
const ID_FAMILIES: Family[] = ["int", "num", "text"];

/**
 * SELECT `columns` (as text) FROM `from` [WHERE keyset] [ORDER BY watermark, id] [first `limit` rows]. Without a
 * keyset (a sample, a snapshot) there is no predicate and no order. `columns` must come from the source's catalog.
 */
export function rowsSql(d: Dialect, o: { from: From; columns: Column[]; keyset?: { wm: Column; id: Column; cursor: Cursor }; limit?: number }): Built {
  const { params, p } = binder(d);
  const ref = (c: Column) => `t.${quoteIdent(d, c.name)}`;
  const cols = o.columns.map((c) => `${asText(d, c, ref(c))} AS ${quoteIdent(d, c.name)}`).join(", ");
  let sql = `SELECT ${cols} FROM ${fromSql(d, o.from, p)} t`;
  let ordered = false;
  if (o.keyset) {
    const { wm, id, cursor } = o.keyset;
    const fw = familyOf(d, wm.type), fi = familyOf(d, id.type);
    if (!WM_FAMILIES.includes(fw)) throw specError(`The watermark column "${wm.name}" is ${wm.type}; it must be a date or a timestamp.`);
    if (!ID_FAMILIES.includes(fi)) throw specError(`The id column "${id.name}" is ${id.type}; it must be a number or text.`);
    const w = ref(wm), i = ref(id);
    if (!cursor) sql += ` WHERE ${w} IS NOT NULL`; // keyset can't place a NULL watermark: such rows are never pulled
    else if ("from" in cursor) sql += ` WHERE ${w} >= ${fromText(d, wm, p(cursor.from))}`;
    else if (d === "postgres") sql += ` WHERE (${w}, ${i}) > (${p(cursor.after.wm)}, ${p(cursor.after.id)})`;
    else {
      // no row comparison here: spelled out as a range on the watermark (>=) that an index on (watermark, id) seeks, and
      // the tie on it broken by id; the bare OR form (w > a OR (w = a AND id > b)) may scan in MySQL, SQL Server, Oracle
      const { wm: v, id: k } = cursor.after;
      sql += ` WHERE ${w} >= ${fromText(d, wm, p(v))} AND (${w} > ${fromText(d, wm, p(v))} OR ${i} > ${fromText(d, id, p(k))})`;
    }
    sql += ` ORDER BY ${w}, ${i}`;
    ordered = true;
  }
  if (o.limit !== undefined) {
    if (!Number.isSafeInteger(o.limit) || o.limit < 1) throw new Error("limit must be a positive integer");
    sql += d === "mssql" ? `${ordered ? "" : " ORDER BY (SELECT NULL)"} OFFSET 0 ROWS FETCH NEXT ${o.limit} ROWS ONLY`
      : d === "oracle" ? ` FETCH FIRST ${o.limit} ROWS ONLY` : ` LIMIT ${o.limit}`;
  }
  return { sql, params };
}
