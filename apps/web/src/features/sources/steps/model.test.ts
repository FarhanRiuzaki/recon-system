import { describe, expect, it } from "vitest";
import {
  amountProblems, buildSpec, closeConnection, codeOf, saveAndClose, mappingProblem, connChanged, connectionProblems, connKey, type Draft, EMPTY_CONN, emptySpec, fitLookback, pullProblems, repeatedRows, snapshotOf, watermarkKind, watermarkProblems, withEngine, withName,
} from "./model";

const db = (over: Partial<Draft> = {}): Draft => ({ name: "Core", code: "core", kind: "db_watermark", conn: EMPTY_CONN, from: "table", spec: emptySpec("db_watermark"), ...over });

describe("the connection on screen against the stored one (fix round 1, I2)", () => {
  it("any difference replaces it: engine, port, TLS or a credential field", () => {
    expect(connChanged(EMPTY_CONN, EMPTY_CONN)).toBe(false);
    for (const k of ["host", "database", "user", "password"] as const) expect(connChanged({ ...EMPTY_CONN, [k]: "x" }, EMPTY_CONN)).toBe(true);
    expect(connChanged({ ...EMPTY_CONN, tls: !EMPTY_CONN.tls }, EMPTY_CONN)).toBe(true);
    expect(connChanged({ ...EMPTY_CONN, port: "6543" }, EMPTY_CONN)).toBe(true);
    expect(connChanged({ ...EMPTY_CONN, engine: "mysql" }, EMPTY_CONN)).toBe(true);
  });
  it("a replaced connection needs every field but the database (Oracle's service name is needed); the stored one tested as it is needs none", () => {
    const tlsOnly = db({ conn: { ...EMPTY_CONN, tls: false } });
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
    expect(watermarkProblems(db()).map((p) => p.id)).toEqual(["src-input-watermark-column", "src-input-watermark-id_columns"]);
  });
  it("the watermark's kind comes from the source column's type (else the field's): a date only, a date-time, an integer", () => {
    const at = (column: string, engine: Draft["conn"]["engine"] = "postgres") => {
      const d = db({ conn: { ...EMPTY_CONN, engine } });
      return { ...d, spec: { ...d.spec, input: { ...d.spec.input, watermark: { column, id_columns: ["id"] } } as Draft["spec"]["input"],
        fields: [{ name: "f", type: "integer" as const, nullable: false, trim: false }] } };
    };
    const cols = [{ name: "d", type: "date" }, { name: "t", type: "timestamp with time zone" }, { name: "n", type: "bigint" }, { name: "s", type: "text" }]
      .map((c) => ({ ...c, nullable: false, unique: null, indexed: null }));
    expect(["d", "t", "n", "s"].map((c) => watermarkKind(at(c), cols))).toEqual(["date", "time", "int", null]);
    expect(watermarkKind(at("f"), null)).toBe("int"); // a SELECT not read here: the field's type
    expect(watermarkKind(at("D", "oracle"), [{ name: "D", type: "DATE", nullable: false, unique: null, indexed: null }])).toBe("time"); // Oracle's DATE holds a time
    expect(watermarkKind(at(""), cols)).toBeNull();
  });
  it("fitLookback: a date-only watermark looks back at least a day, an integer one in ids (1,000), a date-time in seconds", () => {
    const i = emptySpec("db_watermark").input as Extract<Draft["spec"]["input"], { kind: "db_watermark" }>;
    expect(fitLookback(i, "date")).toMatchObject({ lookback_seconds: 86_400 });
    expect(fitLookback({ ...i, lookback_seconds: 172_800 }, "date")).toMatchObject({ lookback_seconds: 172_800 });
    const int = fitLookback(i, "int");
    expect([int.lookback_ids, "lookback_seconds" in int]).toEqual([1000, false]);
    const back = fitLookback(int, "time");
    expect([back.lookback_seconds, "lookback_ids" in back]).toEqual([300, false]);
    expect(fitLookback(i, null)).toBe(i);
  });
  it("snapshotOf: a date-watermark table read as a snapshot per business date, its fields kept", () => {
    const d = db();
    const w = { ...d, spec: { ...d.spec, mutable: true, fields: [{ name: "d", type: "date" as const, nullable: false, trim: false }],
      input: { ...d.spec.input, table: "core.daily", watermark: { column: "d", id_columns: ["id"] } } as Draft["spec"]["input"] } };
    const s = snapshotOf(w);
    expect([s.kind, s.spec.input, s.spec.mutable, s.spec.fields]).toEqual(["db_snapshot", { kind: "db_snapshot", query: "SELECT * FROM core.daily WHERE d = :business_date", schedule: "0 6 * * *" }, false, w.spec.fields]);
  });
  it("Next asks for the amount's unit, not a currency (optional: read as written); the fixed currency is sent only without a currency column", () => {
    const base = emptySpec("db_watermark");
    const s = { ...base, mapping: { ...base.mapping, amount_minor: { field: "amt" } } };
    expect(amountProblems(s).map((p) => p.id)).toEqual(["src-mapping-amount_minor-unit"]);
    const ok = { ...s, currency: "IDR", mapping: { ...s.mapping, amount_minor: { field: "amt", unit: "minor" as const } } };
    expect(amountProblems(ok)).toEqual([]);
    expect(amountProblems(base)).toEqual([]);
    expect(buildSpec(db({ spec: ok })).currency).toBe("IDR");
    expect("currency" in buildSpec(db({ spec: { ...ok, mapping: { ...ok.mapping, currency: { field: "ccy" } } } }))).toBe(false);
  });
});

describe("values the form derives (REC-F2b)", () => {
  it("the code follows the name until the user edits it", () => {
    expect(codeOf("Catalog check")).toBe("catalog-check");
    expect(codeOf("  Core bank · BI-FAST (CBS)  ")).toBe("core-bank-bi-fast-cbs");
    expect(codeOf("Créance été")).toBe("creance-ete");
    expect(codeOf("x".repeat(80))).toHaveLength(64);
    const empty = db({ name: "", code: "" });
    const named = withName(empty, "Catalog check");
    expect(named.code).toBe("catalog-check");
    expect(withName(named, "Catalog check 2").code).toBe("catalog-check-2");
    expect(withName({ ...named, code: "cat" }, "Other").code).toBe("cat");
  });
  it("the port follows the engine unless the user changed it", () => {
    expect(withEngine(EMPTY_CONN, "mysql").port).toBe("3306");
    expect(withEngine({ ...EMPTY_CONN, port: "6543" }, "oracle").port).toBe("6543");
    expect(withEngine({ ...EMPTY_CONN, engine: "mssql", port: "1433" }, "oracle").port).toBe("1521");
  });
  it("a folder is checked without a pattern; Next needs one", () => {
    const f = { ...db(), kind: "file_inbox" as const, spec: emptySpec("file_inbox") };
    const atFolder = { ...f, spec: { ...f.spec, input: { ...f.spec.input, path: "/inbox/ksei" } as typeof f.spec.input } };
    expect(connectionProblems(atFolder, { created: true, replace: false })).toEqual([]);
    expect(pullProblems(atFolder).map((p) => p.id)).toEqual(["src-input-pattern"]);
  });
});

describe("repeatedRows (a key that repeats in the preview)", () => {
  it("counts every row whose key another row has; no value is not counted", () => {
    expect(repeatedRows(["a", "b", "a", "c", "a", null, null], (x) => x)).toBe(3);
    expect(repeatedRows(["a", "b"], (x) => x)).toBe(0);
  });
});

describe("mappingProblem: a recon field reading a column that is gone", () => {
  it("names the column, for a column or a JSON value of it; the file name's date is fine", () => {
    const base = { ...emptySpec("file_inbox"), fields: [{ name: "ref", type: "string" as const, nullable: false, trim: true }] };
    expect(mappingProblem({ ...base, mapping: { ...base.mapping, ext_ref: { cel: 'json_value(row.payload, "data.rc")' } } }))
      .toEqual({ id: "src-mapping-ext_ref", reason: "payload is no longer a column. Pick another column in Use as, or stop using this field." });
    expect(mappingProblem({ ...base, mapping: { ...base.mapping, account_ref: { field: "acct" } } })?.id).toBe("src-mapping-account_ref");
    expect(mappingProblem({ ...base, mapping: { ...base.mapping, ext_ref: { field: "ref" } } })).toBeNull();
  });
});

describe("buildSpec: rows to load", () => {
  it("leaves out a condition still being typed, and the list when none is complete", () => {
    const d = db({ spec: { ...emptySpec("db_watermark"), keep: [{ field: "status", op: "eq", value: " " }, { field: "status", op: "in", values: ["Successful"] }] } });
    expect(buildSpec(d).keep).toEqual([{ field: "status", op: "in", values: ["Successful"] }]);
    expect("keep" in buildSpec(db({ spec: { ...emptySpec("db_watermark"), keep: [{ field: "status", op: "eq", value: "" }] } }))).toBe(false);
  });
});

describe("Save and close keeps what was entered (owner rule: a wizard never loses data)", () => {
  const stored = { ...EMPTY_CONN, host: "db1", user: "u", database: "core" };
  const edited = db({ conn: { ...stored, host: "db2" } });
  const passed = (d: Draft) => ({ result: { ok: true, version: "16" } as never, key: connKey(d) });

  it("a connection as stored, or a file source, has nothing to store", () => {
    expect(closeConnection(db({ conn: stored }), { stored: true, base: stored, tested: null })).toEqual({ kind: "none" });
    expect(closeConnection({ ...db(), kind: "file_inbox", spec: emptySpec("file_inbox") }, { stored: true, base: stored, tested: null })).toEqual({ kind: "none" });
  });
  it("an edited host is checked as Next checks it: the missing password and a connect not run yet hold the close", () => {
    const c = closeConnection(edited, { stored: true, base: stored, tested: null });
    expect(c.kind).toBe("blocked");
    if (c.kind !== "blocked") return;
    expect(c.problems.map((p) => p.id)).toEqual(["src-password"]);
    const typed = db({ conn: { ...edited.conn, password: "p" } });
    const untested = closeConnection(typed, { stored: true, base: stored, tested: null });
    expect(untested).toEqual({ kind: "blocked", problems: [], reason: "Connect with the changed values, then save and close." });
    // a pass over other values counts no more
    expect(closeConnection(typed, { stored: true, base: stored, tested: passed(edited) })).toMatchObject({ kind: "blocked", reason: "The connection changed since you connected. Connect again." });
    expect(closeConnection(typed, { stored: true, base: stored, tested: passed(typed) })).toEqual({ kind: "commit" });
  });
  it("stores the connection, then saves the spec waiting to autosave, then leaves; any refusal stays on the page", async () => {
    const calls: string[] = [];
    const run = (commit: boolean, flush: boolean) => ({
      commit: async () => { calls.push("commit"); return commit; }, flush: async () => { calls.push("flush"); return flush; },
      leave: () => calls.push("leave"), blocked: () => calls.push("blocked"),
    });
    expect(await saveAndClose({ kind: "commit" }, run(true, true))).toBe(true);
    expect(calls.splice(0)).toEqual(["commit", "flush", "leave"]);
    expect(await saveAndClose({ kind: "none" }, run(true, true))).toBe(true);
    expect(calls.splice(0)).toEqual(["flush", "leave"]);
    expect(await saveAndClose({ kind: "commit" }, run(false, true))).toBe(false);
    expect(calls.splice(0)).toEqual(["commit"]);
    expect(await saveAndClose({ kind: "none" }, run(true, false))).toBe(false);
    expect(calls.splice(0)).toEqual(["flush"]);
    expect(await saveAndClose({ kind: "blocked", problems: [], reason: "x" }, run(true, true))).toBe(false);
    expect(calls.splice(0)).toEqual(["blocked"]);
  });
});
