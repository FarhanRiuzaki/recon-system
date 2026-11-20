// Source database connectors (spec §7 "Konektor DB sumber"): one contract, one driver file per engine (the only files
// that import their driver: boundaries.test.ts). Task 5's pipeline drives pulls; the sources module tests a connection,
// introspects a table and pulls a preview sample.
//
// - Identifiers come only from the source's catalog: every column a pull names (the spec's fields, the watermark and id
//   columns) must be one `introspect` returned, else a spec error ("Column "x" is not in table core.txn.").
// - Rows come back as text (dialect.ts): `Row` = column → string, SQL NULL → null (never ""), so row_hash and the
//   natural key tell them apart.
// - A watermark pull is keyset paging (S7): each page `chunk` rows ordered by (watermark, id), the next page after the
//   last row's (watermark, id) as text. With a cursor and lookback, the first page starts `lookbackSeconds` before the
//   cursor's watermark (`>=`); Task 5's dedup drops what comes again. A page is fully read before the next query, and
//   the caller consumes it before asking for more, so memory stays at one page.
// - Every driver error becomes a ConnectorError with a fixed sentence (errors.ts); nothing here logs.
import type { DbEngine } from "@starterkit/shared/sources";
import type { Readable } from "node:stream";
import {
  CATALOG_DATABASES_MAX, CATALOG_TABLES_PAGE, type CatalogFilter, type CatalogTable, catalogSql, type Column, type Cursor, databasesSql, describeSql, type From, minusSeconds, pingSql,
  rowsSql, serverSql, tableCountSql, tablesSql,
} from "./dialect";
import { classify, type ConnectorError, connectTimeoutError, deadlineError, isConnectTimeout, specError } from "./errors";
import { mssqlDriver } from "./mssql";
import { mysqlDriver } from "./mysql";
import { oracleDriver } from "./oracle";
import { postgresDriver } from "./postgres";

export { CATALOG_COUNT_CAP, CATALOG_DATABASES_MAX, CATALOG_TABLES_PAGE, type CatalogTable, type Column, DEFAULT_DATABASE, type From } from "./dialect";
export { ConnectorError, type ConnectorErrorKind, HOSTNAME_MISMATCH_CODES, NO_TLS_CODES } from "./errors";

/** The stored credential (sources.source_connections.secret_enc, decrypted). */
export type Secret = { host: string; port: number; database: string; user: string; password: string };
export type ConnectorOptions = { tls: boolean; connectTimeoutSeconds: number; statementTimeoutMs: number };
export type Row = Record<string, string | null>;
export type DriverConfig = Secret & ConnectorOptions;
/** What an engine file gives: rows of one statement, the result columns of one, a cursor over one, and close. */
export type Driver = {
  rows(sql: string, params: (string | null)[]): Promise<Record<string, unknown>[]>;
  describe(sql: string, params: (string | null)[]): Promise<Column[]>;
  stream(sql: string, params: (string | null)[], chunk: number): AsyncGenerator<Record<string, unknown>[]>;
  close(): Promise<void>;
};

export type WatermarkPull = {
  from: From;
  /** The spec's field names; the watermark and id columns are added. */
  columns: string[];
  watermark: { column: string; id_column: string };
  /** The last row pulled before (its watermark and id as this connector wrote them), or null for the start. */
  after: { wm: string; id: string } | null;
  lookbackSeconds: number;
  chunk: number;
};

export type Connector = {
  /** Connects and runs SELECT 1. */
  test(): Promise<void>;
  /** A table's columns from the catalog (spec error when there is none), or a SELECT's result columns. */
  introspect(from: From): Promise<Column[]>;
  pullWatermark(o: WatermarkPull): AsyncGenerator<Row[]>;
  /** IT's snapshot SELECT for one business date (`:business_date` bound), streamed `chunk` rows at a time. */
  pullSnapshot(query: string, businessDate: string, o: { columns: string[]; chunk: number }): AsyncGenerator<Row[]>;
  /** The first `limit` rows of `from`, no watermark predicate (preview). */
  sample(from: From, columns: string[], limit: number): Promise<Row[]>;
  /** The server's version, the login and the database (Oracle: its name) the session is in. */
  server(): Promise<{ version: string; user: string; database: string | null }>;
  /** The databases this login can open (Oracle: the schemas it can read in), CATALOG_DATABASES_MAX at most. */
  databases(): Promise<{ names: string[]; truncated: boolean }>;
  /** One page (CATALOG_TABLES_PAGE) of the tables and views this login can SELECT, after `after`; `next` = the page after. */
  tables(f: CatalogFilter & { after?: { schema: string; name: string } }): Promise<{ items: CatalogTable[]; next: { schema: string; name: string } | null }>;
  /** How many tables and views `f` matches, counted up to `cap`. */
  countTables(f: CatalogFilter, cap: number): Promise<number>;
  close(): Promise<void>;
};

const DRIVERS: Record<DbEngine, (c: DriverConfig) => Driver> = { postgres: postgresDriver, mysql: mysqlDriver, mssql: mssqlDriver, oracle: oracleDriver };

/** Rows of an object-mode stream in arrays of `chunk`, read as the consumer asks (back-pressure). */
export async function* batches(s: Readable, chunk: number): AsyncGenerator<Record<string, unknown>[]> {
  let page: Record<string, unknown>[] = [];
  for await (const row of s) {
    page.push(row as Record<string, unknown>);
    if (page.length >= chunk) { yield page; page = []; }
  }
  if (page.length) yield page;
}

/** The connector of `engine`; nothing connects until the first call. Call close() when done. */
export function connectorFor(engine: DbEngine, secret: Secret, options: ConnectorOptions): Connector {
  const t = { connectS: options.connectTimeoutSeconds, statementS: Math.ceil(options.statementTimeoutMs / 1000) };
  const perAttempt = { ...secret, ...options, connectTimeoutSeconds: Math.max(1, Math.floor(options.connectTimeoutSeconds * ATTEMPT_SHARE)) };
  return connectorOver(engine, retryingConnect(() => DRIVERS[engine](perAttempt), t), t);
}

// A connect that stalls is retried once on a fresh driver: through Docker Desktop's host.docker.internal the dev stack saw
// 8006 ms and 5248 ms stalls on two concurrent tests ending together (api log 2026-11-21), while 300+ cold connects
// from the container took 6-43 ms. Each attempt gets 40 % of the connect timeout, so two leave room for the statements
// inside the caller's deadline. Only a classified connect timeout, and only before the driver answered once.
const ATTEMPTS = 2;
const ATTEMPT_SHARE = 0.4;

/** A driver that starts over once on a fresh one when the connect times out; its timeout error counts the time spent. */
export function retryingConnect(make: () => Driver, t: { connectS: number; statementS: number }): Driver {
  let drv = make();
  let connected = false;
  const started = Date.now();
  let attempt = 1;
  /** Whether `e` is a connect timeout to retry (swaps in a fresh driver), else the error to throw. */
  function again(e: unknown): true | ConnectorError {
    const c = classify(e, t);
    if (connected || !isConnectTimeout(c)) return c;
    if (attempt >= ATTEMPTS) return connectTimeoutError(c.code, Math.max(1, Math.round((Date.now() - started) / 1000)));
    attempt++;
    const stale = drv;
    drv = make();
    void stale.close().catch(() => {});
    return true;
  }
  async function run<T>(f: (d: Driver) => Promise<T>): Promise<T> {
    for (;;) {
      try {
        const r = await f(drv);
        connected = true;
        return r;
      } catch (e) {
        const r = again(e);
        if (r !== true) throw r;
      }
    }
  }
  return {
    rows: (q, p) => run((d) => d.rows(q, p)),
    describe: (q, p) => run((d) => d.describe(q, p)),
    async *stream(q, p, chunk) {
      for (;;) {
        let first = true;
        try {
          for await (const page of drv.stream(q, p, chunk)) { first = false; connected = true; yield page; }
          return;
        } catch (e) {
          if (!first) throw e;
          const r = again(e);
          if (r !== true) throw r;
        }
      }
    },
    close: () => drv.close(),
  };
}

/** The connector logic over any driver of dialect `d` (connectorFor's engine driver, or a test's fake). */
export function connectorOver(d: DbEngine, drv: Driver, t: { connectS: number; statementS: number }): Connector {
  const wrap = <T>(p: Promise<T>): Promise<T> => p.catch((e) => { throw classify(e, t); });
  const where = (from: From) => ("table" in from ? `table ${from.table}` : "the query");
  const text = (r: Record<string, unknown>, cols: Column[]): Row => Object.fromEntries(cols.map((c) => [c.name, r[c.name] == null ? null : String(r[c.name])]));

  async function introspect(from: From): Promise<Column[]> {
    if ("table" in from) {
      const b = catalogSql(d, from.table);
      const rows = await wrap(drv.rows(b.sql, b.params));
      if (!rows.length) throw specError(`There is no table or view ${from.table} that this user can read.`);
      const yes = (v: unknown) => /^y/i.test(String(v));
      return rows.map((r) => ({ name: String(r.name), type: String(r.type), nullable: yes(r.nullable), unique: yes(r.unique), indexed: yes(r.indexed) }));
    }
    const b = describeSql(d, from);
    const cols = await wrap(drv.describe(b.sql, b.params));
    const twice = cols.find((c, i) => cols.findIndex((x) => x.name === c.name) !== i);
    if (twice) throw specError(`The query returns column "${twice.name}" twice. Give each column its own name.`);
    return cols.map((c) => ({ ...c, unique: null, indexed: null }));
  }

  /** `names` as catalog columns, in that order; a name the source lacks is a spec error. */
  function pick(all: Column[], names: string[], from: From): Column[] {
    return names.map((n) => {
      const c = all.find((x) => x.name === n);
      if (!c) throw specError(`Column "${n}" is not in ${where(from)}.`);
      return c;
    });
  }

  async function* pullWatermark(o: WatermarkPull): AsyncGenerator<Row[]> {
    const all = await introspect(o.from);
    const [wm, id] = pick(all, [o.watermark.column, o.watermark.id_column], o.from) as [Column, Column];
    const cols = pick(all, [...new Set([...o.columns, wm.name, id.name])], o.from);
    let cursor: Cursor = o.after === null ? null : o.lookbackSeconds > 0 ? { from: minusSeconds(o.after.wm, o.lookbackSeconds) } : { after: o.after };
    for (;;) {
      const b = rowsSql(d, { from: o.from, columns: cols, keyset: { wm, id, cursor }, limit: o.chunk });
      const page = (await wrap(drv.rows(b.sql, b.params))).map((r) => text(r, cols));
      if (page.length) yield page;
      if (page.length < o.chunk) return;
      const last = page[page.length - 1]!;
      const next = { wm: last[wm.name]!, id: last[id.name]! };
      // a full page that ends where it started: the source compares the columns differently from their text (a SQL
      // Server datetime read back at another precision, a collation); asking again would return the same page forever
      if (cursor && "after" in cursor && cursor.after.wm === next.wm && cursor.after.id === next.id) {
        throw specError(`The pull did not move past watermark ${next.wm} and id ${next.id}: the source compares "${wm.name}" or "${id.name}" differently from its own text. Use another watermark or id column.`);
      }
      cursor = { after: next };
    }
  }

  async function* pullSnapshot(query: string, businessDate: string, o: { columns: string[]; chunk: number }): AsyncGenerator<Row[]> {
    const from: From = { query, businessDate };
    const cols = pick(await introspect(from), o.columns, from);
    const b = rowsSql(d, { from, columns: cols });
    try {
      for await (const page of drv.stream(b.sql, b.params, o.chunk)) yield page.map((r) => text(r, cols));
    } catch (e) {
      throw classify(e, t);
    }
  }

  return {
    test: async () => { await wrap(drv.rows(pingSql(d), [])); },
    introspect,
    pullWatermark,
    pullSnapshot,
    async sample(from, columns, limit) {
      const cols = pick(await introspect(from), columns, from);
      const b = rowsSql(d, { from, columns: cols, limit });
      return (await wrap(drv.rows(b.sql, b.params))).map((r) => text(r, cols));
    },
    async server() {
      const [r] = await wrap(drv.rows(serverSql(d), []));
      const str = (v: unknown) => (v == null ? "" : String(v));
      return { version: str(r?.version), user: str(r?.user), database: r?.database == null ? null : String(r.database) };
    },
    async databases() {
      const names = (await wrap(drv.rows(databasesSql(d), []))).map((r) => String(r.name));
      return { names: names.slice(0, CATALOG_DATABASES_MAX), truncated: names.length > CATALOG_DATABASES_MAX };
    },
    async tables(f) {
      const b = tablesSql(d, { ...f, limit: CATALOG_TABLES_PAGE + 1 });
      const rows = (await wrap(drv.rows(b.sql, b.params))).map((r): CatalogTable => ({
        schema: String(r.schema), name: String(r.name), kind: r.kind === "view" ? "view" : "table", columns: Number(r.columns),
      }));
      const items = rows.slice(0, CATALOG_TABLES_PAGE);
      const last = items[items.length - 1];
      return { items, next: rows.length > CATALOG_TABLES_PAGE && last ? { schema: last.schema, name: last.name } : null };
    },
    async countTables(f, cap) {
      const b = tableCountSql(d, f, cap);
      const [r] = await wrap(drv.rows(b.sql, b.params));
      return Number(r?.n ?? 0);
    },
    close: () => drv.close().catch(() => {}),
  };
}

/**
 * `fn(connector)` within `seconds` in all (connect and statements together); the connector is then closed in the
 * background. For a request
 * someone waits on: the web's backend client gives up after 10 s (apps/web/src/lib/server/backend.ts).
 */
export async function within<T>(c: Connector, seconds: number, fn: (c: Connector) => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([fn(c), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(deadlineError(seconds)), seconds * 1000); })]);
  } finally {
    clearTimeout(timer);
    // not awaited: a driver may close only after its in-flight statement ends, past the deadline the caller waits on
    void c.close().catch(() => {});
  }
}
