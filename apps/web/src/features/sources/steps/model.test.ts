import { describe, expect, it } from "vitest";
import { connChanged, connectionProblems, connKey, type Draft, EMPTY_CONN, emptySpec, watermarkProblems } from "./model";

const db = (over: Partial<Draft> = {}): Draft => ({ name: "Core", code: "core", kind: "db_watermark", conn: EMPTY_CONN, from: "table", spec: emptySpec("db_watermark"), ...over });

describe("the connection on screen against the stored one (fix round 1, I2)", () => {
  it("any difference replaces it: engine, port, TLS or a credential field", () => {
    expect(connChanged(EMPTY_CONN, EMPTY_CONN)).toBe(false);
    for (const k of ["host", "database", "user", "password"] as const) expect(connChanged({ ...EMPTY_CONN, [k]: "x" }, EMPTY_CONN)).toBe(true);
    expect(connChanged({ ...EMPTY_CONN, tls: true }, EMPTY_CONN)).toBe(true);
    expect(connChanged({ ...EMPTY_CONN, port: "6543" }, EMPTY_CONN)).toBe(true);
    expect(connChanged({ ...EMPTY_CONN, engine: "mysql" }, EMPTY_CONN)).toBe(true);
  });
  it("a replaced connection needs every field; the stored one tested as it is needs none", () => {
    const tlsOnly = db({ conn: { ...EMPTY_CONN, tls: true } });
    expect(connectionProblems(tlsOnly, { created: true, replace: true }).map((p) => p.id)).toEqual(["src-host", "src-database", "src-user", "src-password"]);
    expect(connectionProblems(db(), { created: true, replace: false })).toEqual([]);
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
});
