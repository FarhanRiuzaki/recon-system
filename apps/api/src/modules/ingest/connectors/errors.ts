// What went wrong talking to a source database, as one fixed English sentence per class with the driver's code
// quoted (ORA-01017, ER_ACCESS_DENIED_ERROR, ELOGIN, 28P01 …). The driver's own message is read by nobody: it can
// echo the host, the user or the SQL, so it never reaches an answer, a log line or this error (no `cause` kept).
//
// Codes per driver, as far as checked: PostgreSQL (Bun.SQL) puts SQLSTATE in `errno` and its own ERR_POSTGRES_* in
// `code` (both seen against the local cluster); mysql2 ER_* / Node socket codes; mssql ELOGIN / ESOCKET / ETIMEOUT with
// the server's number in `originalError.info.number` (4060 = database not found); oracledb ORA-* / NJS-* in `code`.
// Only PostgreSQL's codes were seen on a real server (spike S7, this task's tests); the others come from the drivers'
// documentation and S7's closed-port / blackhole runs (docs/recon/spikes.md).

export type ConnectorErrorKind = "timeout" | "login" | "tls" | "host" | "database" | "query" | "spec";

const CODES: Record<Exclude<ConnectorErrorKind, "query" | "spec">, string[]> = {
  timeout: ["ETIMEDOUT", "ETIMEOUT", "ERR_POSTGRES_CONNECTION_TIMEOUT", "ERR_MYSQL_CONNECTION_TIMEOUT", "PROTOCOL_SEQUENCE_TIMEOUT", "NJS-510"],
  login: ["28P01", "28000", "ER_ACCESS_DENIED_ERROR", "ER_DBACCESS_DENIED_ERROR", "ER_NOT_SUPPORTED_AUTH_MODE", "ELOGIN", "ORA-01017", "ORA-28000", "ORA-28001", "ORA-01005"],
  tls: [
    "ERR_POSTGRES_TLS_NOT_AVAILABLE", "ERR_POSTGRES_TLS_UPGRADE_FAILED", "HANDSHAKE_NO_SSL_SUPPORT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN",
    "DEPTH_ZERO_SELF_SIGNED_CERT", "CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_GET_ISSUER_CERT", "ORA-29024",
  ],
  host: [
    "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ECONNRESET", "ERR_POSTGRES_CONNECTION_REFUSED", "ERR_MYSQL_CONNECTION_REFUSED",
    "ESOCKET", "NJS-503", "NJS-501", "NJS-511", "ORA-12541", "ORA-12545", "ORA-12543",
  ],
  database: ["3D000", "ER_BAD_DB_ERROR", "4060", "ORA-12514", "ORA-12505", "NJS-518"],
};
/** TLS codes that mean the server offers no TLS at all (the other TLS codes: its certificate isn't trusted). */
export const NO_TLS_CODES = ["ERR_POSTGRES_TLS_NOT_AVAILABLE", "HANDSHAKE_NO_SSL_SUPPORT"];
/** Timeouts of a statement (not of the connect): their message names the statement timeout. */
const STATEMENT_TIMEOUTS = ["57014", "ER_QUERY_TIMEOUT", "ORA-01013", "DPI-1067", "NJS-123"];
const KIND = new Map<string, ConnectorErrorKind>([
  ...Object.entries(CODES).flatMap(([k, codes]) => codes.map((c): [string, ConnectorErrorKind] => [c, k as ConnectorErrorKind])),
  ...STATEMENT_TIMEOUTS.map((c): [string, ConnectorErrorKind] => [c, "timeout"]),
]);
/** A code is quoted only when it looks like one: letters, digits, `_` and `-`. */
const SAFE_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{1,39}$/;

const text = (kind: ConnectorErrorKind, code: string | null, seconds: number): string => {
  const c = code ? ` (${code})` : "";
  switch (kind) {
    case "timeout": return `The server did not answer within ${seconds} s.`;
    case "login": return `The server refused the login${c}. Check the user and password.`;
    case "tls": return `The server's TLS certificate is not trusted, or the server does not offer TLS${c}.`;
    case "host": return `The host could not be reached${c}. Check the host and port, and that this server may connect to it.`;
    case "database": return `The database was not found${c}. Check the database name.`;
    default: return `The source database refused the query${c}.`;
  }
};

/** A failure of a source connector: `kind` decides the sentence, `code` is the driver's code (or null). */
export class ConnectorError extends Error {
  constructor(readonly kind: ConnectorErrorKind, readonly code: string | null, message: string) {
    super(message);
    this.name = "ConnectorError";
  }
}

/** A mistake in the source's spec against the source (unknown column, a SELECT that isn't one): the message is ours. */
export const specError = (message: string) => new ConnectorError("spec", null, message);

/** The codes an error carries, most specific first (server numbers, nested causes, then the outer code). */
function codesOf(e: unknown): string[] {
  const o = (e ?? {}) as Record<string, unknown>;
  const orig = (o.originalError ?? {}) as Record<string, unknown>;
  const info = (orig.info ?? {}) as Record<string, unknown>;
  const cause = (o.cause ?? {}) as Record<string, unknown>;
  return [o.errno, info.number, orig.number, o.number, orig.code, cause.code, o.code]
    .filter((v) => typeof v === "string" || typeof v === "number").map(String).filter((v) => SAFE_CODE.test(v));
}

/** A driver's error as a ConnectorError; one already is passes through. `connectS` / `statementS` = the connector's timeouts. */
export function classify(e: unknown, t: { connectS: number; statementS: number }): ConnectorError {
  if (e instanceof ConnectorError) return e;
  const codes = codesOf(e);
  const hit = codes.find((c) => KIND.has(c));
  const kind = hit ? KIND.get(hit)! : "query";
  const code = hit ?? codes[0] ?? null;
  return new ConnectorError(kind, code, text(kind, code, hit && STATEMENT_TIMEOUTS.includes(hit) ? t.statementS : t.connectS));
}

/** The timeout of a whole operation (connect and statements together), with no driver code. */
export const deadlineError = (seconds: number) => new ConnectorError("timeout", null, text("timeout", null, seconds));
