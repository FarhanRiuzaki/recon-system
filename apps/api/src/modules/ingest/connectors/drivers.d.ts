// The few members of `mssql` 12.7.15 and `oracledb` 26.0.0 this module uses: neither package ships its own types, and
// a hand-written subset is smaller than two @types packages to pin. Checked against the packages' lib/ sources.

declare module "mssql" {
  import type { Readable } from "node:stream";
  export type ColumnMetadata = { name: string; nullable?: boolean; scale?: number; type: { declaration?: string } };
  export type RecordSet = Record<string, unknown>[] & { columns: Record<string, ColumnMetadata> };
  export class Request {
    input(name: string, value: unknown): this;
    query(sql: string): Promise<{ recordset: RecordSet }>;
    toReadableStream(options?: { highWaterMark?: number }): Readable;
  }
  export class ConnectionPool {
    constructor(config: Record<string, unknown>);
    connect(): Promise<ConnectionPool>;
    request(): Request;
    close(): Promise<void>;
  }
}

declare module "oracledb" {
  export type Metadata = { name: string; dbType?: unknown; dbTypeName?: string; precision?: number; scale?: number; nullable?: boolean };
  export type ResultSet = { getRows(n: number): Promise<Record<string, unknown>[]>; close(): Promise<void> };
  export type Result = { rows?: Record<string, unknown>[]; metaData?: Metadata[]; resultSet?: ResultSet };
  export type Connection = {
    callTimeout: number;
    execute(sql: string, binds?: unknown[], options?: Record<string, unknown>): Promise<Result>;
    commit(): Promise<void>;
    rollback(): Promise<void>;
    close(): Promise<void>;
  };
  const oracledb: {
    thin: boolean;
    OUT_FORMAT_OBJECT: number;
    STRING: number;
    DB_TYPE_CLOB: unknown;
    DB_TYPE_NCLOB: unknown;
    DB_TYPE_RAW: unknown;
    getConnection(config: Record<string, unknown>): Promise<Connection>;
  };
  export default oracledb;
}
