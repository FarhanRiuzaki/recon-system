// "Paste a connection string" (REC-F2b): the string IT hands over, read in the browser into the connection fields.
// Never sent, stored or logged whole; a password is taken only when the string has one.
import type { DbEngine } from "@starterkit/shared/sources";
import { DEFAULT_PORT } from "./model";

export type ParsedConn = { engine: DbEngine; host: string; port: string; database: string; user: string; password?: string };

const SCHEMES: Record<string, DbEngine> = { postgresql: "postgres", postgres: "postgres", mysql: "mysql", sqlserver: "mssql", mssql: "mssql", oracle: "oracle" };
const dec = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

/**
 * postgresql://user:pass@host:5432/db, mysql://…, sqlserver:// or mssql://… (also `;databaseName=…;user=…;password=…`
 * properties), oracle://user@host:1521/service and Oracle Easy Connect (`jdbc:oracle:thin:@//host:1521/service`); a
 * leading `jdbc:` is dropped. The port defaults to the engine's. null when it isn't one of these.
 */
export function parseConnString(raw: string): ParsedConn | null {
  let s = raw.trim().replace(/^jdbc:/i, "");
  const thin = /^oracle:thin:@(?:\/\/)?(.*)$/i.exec(s);
  if (thin) s = `oracle://${thin[1]}`;
  const scheme = /^([a-z]+):\/\//i.exec(s)?.[1]?.toLowerCase();
  const engine = scheme ? SCHEMES[scheme] : undefined;
  if (!engine) return null;
  // SQL Server's properties after the host: ;databaseName=x;user=y;password=z
  const [head = "", ...props] = s.split(";");
  let url: URL;
  try { url = new URL(head.replace(/^[a-z]+:/i, "x:")); } catch { return null; }
  if (!url.hostname) return null;
  const out: ParsedConn = {
    engine, host: url.hostname.replace(/^\[(.*)\]$/, "$1"), port: url.port || DEFAULT_PORT[engine],
    database: dec(url.pathname.replace(/^\//, "")), user: dec(url.username),
  };
  if (url.password) out.password = dec(url.password);
  const q = new Map([...url.searchParams].map(([k, v]) => [k.toLowerCase(), v]));
  for (const p of props) { const i = p.indexOf("="); if (i > 0) q.set(p.slice(0, i).trim().toLowerCase(), p.slice(i + 1).trim()); }
  out.database ||= q.get("databasename") ?? q.get("database") ?? q.get("dbname") ?? "";
  out.user ||= q.get("user") ?? q.get("username") ?? q.get("user id") ?? "";
  const pw = q.get("password");
  if (!out.password && pw) out.password = pw;
  return out;
}
