import { describe, expect, it } from "vitest";
import { parseConnString } from "./conn-string";

describe("parseConnString (REC-F2b)", () => {
  it("reads each scheme; the port defaults to the engine's", () => {
    expect(parseConnString("postgresql://recon_ro@localhost:5432/recon_core")).toEqual({ engine: "postgres", host: "localhost", port: "5432", database: "recon_core", user: "recon_ro" });
    expect(parseConnString("postgres://recon_ro@db.bank.local/core")).toMatchObject({ engine: "postgres", port: "5432", database: "core" });
    expect(parseConnString("mysql://app:s%40cret@10.0.0.5/ledger")).toEqual({ engine: "mysql", host: "10.0.0.5", port: "3306", database: "ledger", user: "app", password: "s@cret" });
    expect(parseConnString("mssql://sa@sql01:1444/core")).toMatchObject({ engine: "mssql", host: "sql01", port: "1444", database: "core", user: "sa" });
    expect(parseConnString("jdbc:sqlserver://sql01:1433;databaseName=core;user=recon_ro;password=pw;encrypt=true"))
      .toEqual({ engine: "mssql", host: "sql01", port: "1433", database: "core", user: "recon_ro", password: "pw" });
    expect(parseConnString("oracle://RECON_RO@ora01:1521/BIFASTPRD")).toEqual({ engine: "oracle", host: "ora01", port: "1521", database: "BIFASTPRD", user: "RECON_RO" });
    expect(parseConnString("jdbc:oracle:thin:@//ora01:1522/BIFASTPRD")).toEqual({ engine: "oracle", host: "ora01", port: "1522", database: "BIFASTPRD", user: "" });
  });
  it("takes a password only when the string has one", () => {
    expect(parseConnString("postgresql://recon_ro@localhost/db")).not.toHaveProperty("password");
    expect(parseConnString("postgresql://recon_ro:@localhost/db")).not.toHaveProperty("password");
    expect(parseConnString("postgresql://recon_ro:p%3Aw@localhost/db")?.password).toBe("p:w");
  });
  it("is null for what it can't read", () => {
    for (const s of ["", "localhost:5432", "redis://x@h/0", "postgresql://", "postgresql:///db", "not a url"]) expect(parseConnString(s)).toBeNull();
  });
});
