import { describe, expect, it } from "vitest";
import { amountProblems, buildSpec, connChanged, connectionProblems, connKey, type Draft, EMPTY_CONN, emptySpec, pullProblems, watermarkProblems } from "./model";

const db = (over: Partial<Draft> = {}): Draft => ({ name: "Core", code: "core", kind: "db_watermark", conn: EMPTY_CONN, from: "table", spec: emptySpec("db_watermark"), ...over });

describe("the connection on screen against the stored one (fix round 1, I2)", () => {
  it("any difference replaces it: engine, port, TLS or a credential field", () => {
    expect(connChanged(EMPTY_CONN, EMPTY_CONN)).toBe(false);
    for (const k of ["host", "database", "user", "password"] as const) expect(connChanged({ ...EMPTY_CONN, [k]: "x" }, EMPTY_CONN)).toBe(true);
    expect(connChanged({ ...EMPTY_CONN, tls: true }, EMPTY_CONN)).toBe(true);
    expect(connChanged({ ...EMPTY_CONN, port: "6543" }, EMPTY_CONN)).toBe(true);
    expect(connChanged({ ...EMPTY_CONN, engine: "mysql" }, EMPTY_CONN)).toBe(true);
  });
  it("a replaced connection needs every field but the database (Oracle's service name is needed); the stored one tested as it is needs none", () => {
    const tlsOnly = db({ conn: { ...EMPTY_CONN, tls: true } });
    const problems = connectionProblems(tlsOnly, { created: true, replace: true });
    expect(problems.map((p) => p.id)).toEqual(["src-host", "src-user", "src-password"]);
    expect(problems[2]!.reason).toBe("Enter the password again: the connection changed.");
    expect(connectionProblems(db({ conn: { ...EMPTY_CONN, engine: "oracle", tls: true } }), { created: false, replace: true }).map((p) => p.id)).toEqual(["src-host", "src-database", "src-user", "src-password"]);
    expect(connectionProblems(db(), { created: true, replace: false })).toEqual([]);
  });
  it("Next stores a connection only with its database; buildSpec leaves out the fields it is told to drop", () => {
    const d = db({ conn: { ...EMPTY_CONN, host: "h", user: "u", password: "p" } });
    expect(pullProblems(d, { replace: true }).map((p) => p.reason)).toContain("Choose the database, or type its name.");
    expect(pullProblems(d, { replace: false }).map((p) => p.id)).not.toContain("src-database");
    const withFields = { ...d, spec: { ...d.spec, fields: [{ name: "a", type: "string" as const, nullable: true, trim: true }, { name: "gone", type: "string" as const, nullable: true, trim: true }] } };
    expect(buildSpec(withFields, ["gone"]).fields.map((f) => f.name)).toEqual(["a"]);
  });
  it("a test counts for the values it ran with: the folder and pattern of a file source, the whole connection of a database one", () => {
    const f = { ...db(), kind: "file_inbox" as const, spec: emptySpec("file_inbox") };
    const moved = { ...f, spec: { ...f.spec, input: { ...f.spec.input, path: "/inbox/x" } as typeof f.spec.input } };
    expect(connKey(f)).not.toBe(connKey(moved));
    expect(connKey(db())).not.toBe(connKey(db({ conn: { ...EMPTY_CONN, password: "p" } })));
  });
  it("a watermark source picks its watermark and id columns in step 2", () => {
    expect(watermarkProblems(db()).map((p) => p.id)).toEqual(["src-input-watermark-column", "src-input-watermark-id_column"]);
  });
  it("Next asks for the amount's unit and a currency; the fixed currency is sent only without a currency column", () => {
    const base = emptySpec("db_watermark");
    const s = { ...base, mapping: { ...base.mapping, amount_minor: { field: "amt" } } };
    expect(amountProblems(s).map((p) => p.id)).toEqual(["src-mapping-amount_minor-unit", "src-currency"]);
    const ok = { ...s, currency: "IDR", mapping: { ...s.mapping, amount_minor: { field: "amt", unit: "minor" as const } } };
    expect(amountProblems(ok)).toEqual([]);
    expect(amountProblems(base)).toEqual([]);
    expect(buildSpec(db({ spec: ok })).currency).toBe("IDR");
    expect("currency" in buildSpec(db({ spec: { ...ok, mapping: { ...ok.mapping, currency: { field: "ccy" } } } }))).toBe(false);
  });
});
