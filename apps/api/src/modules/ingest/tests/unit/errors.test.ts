// A driver's error to one fixed message per class with only the driver's code quoted (connectors/errors.ts): the
// driver's own text can echo the host, the user or the SQL, so it never reaches the message.
import { describe, expect, it } from "bun:test";
import { classify, ConnectorError } from "../../connectors/errors";

const SECRET = "core-db.bank.internal recon_ro Pa55-word";
const fake = (props: Record<string, unknown>) => Object.assign(new Error(`login failed for ${SECRET}`), props);
const t = { connectS: 8, statementS: 8 };

describe("classify", () => {
  it("maps each engine's codes to a class and quotes the code", () => {
    const cases: [Record<string, unknown>, string, string | null][] = [
      [{ code: "ERR_POSTGRES_SERVER_ERROR", errno: "28P01" }, "login", "28P01"],
      [{ code: "ERR_POSTGRES_SERVER_ERROR", errno: "3D000" }, "database", "3D000"],
      [{ code: "ERR_POSTGRES_SERVER_ERROR", errno: "57014" }, "timeout", "57014"],
      [{ code: "ERR_POSTGRES_CONNECTION_TIMEOUT" }, "timeout", "ERR_POSTGRES_CONNECTION_TIMEOUT"],
      [{ code: "ERR_POSTGRES_CONNECTION_REFUSED" }, "host", "ERR_POSTGRES_CONNECTION_REFUSED"],
      [{ code: "ERR_POSTGRES_TLS_NOT_AVAILABLE" }, "tls", "ERR_POSTGRES_TLS_NOT_AVAILABLE"],
      [{ code: "ER_ACCESS_DENIED_ERROR", errno: 1045 }, "login", "ER_ACCESS_DENIED_ERROR"],
      [{ code: "ER_BAD_DB_ERROR", errno: 1049 }, "database", "ER_BAD_DB_ERROR"],
      [{ code: "ETIMEDOUT" }, "timeout", "ETIMEDOUT"],
      [{ code: "ENOTFOUND" }, "host", "ENOTFOUND"],
      [{ code: "ELOGIN", originalError: { info: { number: 18456 } } }, "login", "ELOGIN"],
      [{ code: "ELOGIN", originalError: { info: { number: 4060 } } }, "database", "4060"],
      [{ code: "ESOCKET", originalError: { code: "SELF_SIGNED_CERT_IN_CHAIN" } }, "tls", "SELF_SIGNED_CERT_IN_CHAIN"],
      [{ code: "ESOCKET" }, "host", "ESOCKET"],
      [{ code: "ORA-01017" }, "login", "ORA-01017"],
      [{ code: "ORA-12514" }, "database", "ORA-12514"],
      [{ code: "NJS-510" }, "timeout", "NJS-510"],
      [{ code: "NJS-503" }, "host", "NJS-503"],
      [{ code: "ERR_POSTGRES_SERVER_ERROR", errno: "42P01" }, "query", "42P01"],
      [{}, "query", null],
      [{ code: "has spaces and a host core-db" }, "query", null],
    ];
    for (const [props, kind, code] of cases) {
      const e = classify(fake(props), t);
      expect([props, e.kind, e.code]).toEqual([props, kind, code]);
      expect(e.message).not.toContain("core-db");
      expect(e.message).not.toContain("recon_ro");
    }
  });

  it("answers the fixed message of each class", () => {
    expect(classify(fake({ code: "ETIMEDOUT" }), t).message).toBe("The server did not answer within 8 s.");
    expect(classify(fake({ code: "ORA-01017" }), t).message).toBe("The server refused the login (ORA-01017). Check the user and password.");
    expect(classify(fake({ code: "ENOTFOUND" }), t).message).toBe("The host could not be reached (ENOTFOUND). Check the host and port, and that this server may connect to it.");
    expect(classify(fake({ code: "ER_BAD_DB_ERROR" }), t).message).toBe("The database was not found (ER_BAD_DB_ERROR). Check the database name.");
    expect(classify(fake({ code: "CERT_HAS_EXPIRED" }), t).message).toBe("The server's TLS certificate is not trusted, or the server does not offer TLS (CERT_HAS_EXPIRED).");
    expect(classify(fake({ errno: "42501" }), t).message).toBe("The source database refused the query (42501).");
    expect(classify(fake({}), t).message).toBe("The source database refused the query.");
  });

  it("a statement timeout names the statement timeout; a ConnectorError passes through as it is", () => {
    expect(classify(fake({ errno: "57014" }), { connectS: 15, statementS: 120 }).message).toBe("The server did not answer within 120 s.");
    expect(classify(fake({ code: "ETIMEDOUT" }), { connectS: 15, statementS: 120 }).message).toBe("The server did not answer within 15 s.");
    const own = new ConnectorError("spec", null, 'Column "x" is not in the source.');
    expect(classify(own, t)).toBe(own);
  });
});

describe("a certificate for another host name", () => {
  const code = "ERR_TLS_CERT_ALTNAME_INVALID";
  it("is a tls error that carries the certificate's first DNS name, from cert, wrapped cert or message", () => {
    const names = (e: unknown) => classify(e, t).certName;
    expect(names(fake({ code, cert: { subjectaltname: "DNS:db01.bank.local, DNS:b.local, IP Address:10.0.0.1" } }))).toBe("db01.bank.local");
    expect(names(fake({ code, cert: { subject: { CN: "db01.bank.local" } } }))).toBe("db01.bank.local");
    expect(names(fake({ code: "ESOCKET", originalError: { code, cert: { subjectaltname: "DNS:sql01.bank.local" } } }))).toBe("sql01.bank.local");
    expect(names(Object.assign(new Error("Hostname/IP does not match certificate's altnames: Host: x. is not in the cert's altnames: DNS:db01.bank.local"), { code }))).toBe("db01.bank.local");
    expect(classify(fake({ code }), t)).toMatchObject({ kind: "tls", code, certName: null });
  });
  it("never quotes a name that is not a host name", () => {
    expect(classify(fake({ code, cert: { subjectaltname: "DNS:a;rm" } }), t).certName).toBeNull();
    expect(classify(fake({ code, cert: { subject: { CN: "Pa55 word, x" } } }), t).certName).toBeNull();
  });
});

