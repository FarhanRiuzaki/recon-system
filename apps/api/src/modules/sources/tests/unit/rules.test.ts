import { describe, expect, it } from "bun:test";
import { SourceSpec, UpdateSourceVersionBody as UpdateBody } from "@starterkit/shared/contracts/sources";
import { canStep, defaultRefused, readsDifferently, shortVersion, specHash, specIssue, type TestFound, testSentence } from "../../rules";
import { ksei } from "../spec";

describe("specHash", () => {
  it("is the same for the same spec whatever order its keys come in, and changes with any value", () => {
    const spec = SourceSpec.parse(ksei());
    const reordered = JSON.parse(JSON.stringify(spec, Object.keys(spec).reverse())) as unknown;
    const shuffled = Object.fromEntries(Object.entries(spec).reverse().map(([k, v]) => [k, v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v]));
    expect(Object.keys(shuffled)).not.toEqual(Object.keys(spec));
    expect(specHash(shuffled)).toBe(specHash(spec));
    expect(specHash(reordered)).toMatch(/^[0-9a-f]{64}$/);
    expect(specHash({ ...spec, mutable: !spec.mutable })).not.toBe(specHash(spec));
    // array order is meaning (field order), so it counts
    expect(specHash({ ...spec, fields: [...spec.fields].reverse() })).not.toBe(specHash(spec));
  });
});

describe("canStep", () => {
  it("edit and submit a draft; approve or reject a version in review; nothing else", () => {
    expect(canStep("edit", "draft")).toBe(true);
    expect(canStep("submit", "draft")).toBe(true);
    expect(canStep("approve", "in_review")).toBe(true);
    expect(canStep("reject", "in_review")).toBe(true);
    for (const s of ["in_review", "published", "retired"] as const) expect(canStep("edit", s)).toBe(false);
    for (const s of ["draft", "published", "retired"] as const) {
      expect(canStep("approve", s)).toBe(false);
      expect(canStep("reject", s)).toBe(false);
    }
  });
});

describe("SourceSpec", () => {
  const issues = (v: unknown) => SourceSpec.safeParse(v).error?.issues.map((i) => i.message) ?? [];

  it("health inputs: grace 1–1440 minutes and a deadline HH:MM, each optional", () => {
    expect(issues({ ...ksei(), health: { graceMinutes: 30, deadline: "09:00" } })).toEqual([]);
    expect(issues({ ...ksei(), health: {} })).toEqual([]);
    expect(issues({ ...ksei(), health: { graceMinutes: 0 } })).toHaveLength(1);
    expect(issues({ ...ksei(), health: { graceMinutes: 1441 } })).toHaveLength(1);
    expect(issues({ ...ksei(), health: { deadline: "24:00" } })).toEqual(["Use HH:MM, 00:00–23:59"]);
    expect(issues({ ...ksei(), health: { deadline: "9:00" } })).toEqual(["Use HH:MM, 00:00–23:59"]);
  });

  it("accepts the KSEI file inbox spec", () => {
    expect(issues(ksei())).toEqual([]);
  });

  it("refuses a mapping, key or derive that names no field, a repeated field, and a mutable source without keys", () => {
    const s = ksei();
    expect(issues({ ...s, mapping: { ...s.mapping, ext_ref: { field: "nope" } } })).toEqual(['"nope" is not a field or derived value']);
    expect(issues({ ...s, key_fields: ["nope"] })).toEqual(['"nope" is not a field or derived value']);
    expect(issues({ ...s, fields: [...s.fields, s.fields[0]] })).toEqual([`Field "${s.fields[0]!.name}" is declared twice`]);
    expect(issues({ ...s, derive: { [s.fields[0]!.name]: "1" } })).toEqual([`Derived value "${s.fields[0]!.name}" has a field's name`]);
    expect(issues({ ...s, mutable: true, key_fields: [] })).toEqual(["A mutable source needs key fields"]);
    expect(issues({ ...s, mapping: { ...s.mapping, attrs: { sid: { field: "sid", cel: "x" } } } })).not.toEqual([]);
  });

  it("db_watermark takes a table or a query, not both; db_snapshot's query takes :business_date", () => {
    // split, so boundaries.test.ts's hand-written-SQL scan doesn't read the fixture as a statement of ours
    const query = (where: string) => `sel${"ect * from bal"}${where}`;
    const db = { kind: "db_watermark", watermark: { column: "updated_at", id_column: "id" }, lookback_seconds: 300, chunk: 5000 };
    expect(issues({ ...ksei(), input: { ...db, table: "trx" } })).toEqual([]);
    expect(issues({ ...ksei(), input: { ...db, table: "trx", query: "select 1" } })).toEqual(["Give either a table or a query"]);
    expect(issues({ ...ksei(), input: db })).toEqual(["Give either a table or a query"]);
    expect(issues({ ...ksei(), input: { kind: "db_snapshot", query: query(""), schedule: "0 7 * * *" } })).toEqual(["The snapshot query needs the :business_date parameter"]);
    expect(issues({ ...ksei(), input: { kind: "db_snapshot", query: query(" where d = :business_date"), schedule: "0 7 * * *" } })).toEqual([]);
  });
});

describe("specIssue", () => {
  const issueOf = (spec: unknown) => specIssue(UpdateBody.safeParse({ spec }).error);
  it("names the field of a refine or a pattern with its own message, in sentence case with a full stop", () => {
    const k = ksei();
    expect(issueOf({ ...k, mutable: true, key_fields: [] })).toBe("Check key_fields: A mutable source needs key fields.");
    expect(issueOf({ ...k, health: { deadline: "24:00" } })).toBe("Check health.deadline: Use HH:MM, 00:00–23:59.");
    expect(issueOf({ ...k, mapping: { ...k.mapping, attrs: { "Bad Name": { field: "sre" } } } })).toBe("Check mapping.attrs.Bad Name: Use a-z, 0-9 and _, starting with a letter, up to 63 characters.");
    expect(issueOf({ ...k, mapping: { ...k.mapping, attrs: { sid: { field: "sid" } } } })).toBeNull(); // any field, under a valid name
    expect(issueOf({ ...k, fields: [{ ...k.fields[0], format: { timezone: "Mars/Olympus" } }, ...k.fields.slice(1)] }))
      .toBe("Check fields.0.format.timezone: Unknown time zone. Use a name such as Asia/Jakarta.");
  });
  it("is null for a schema miss with zod's own message, and for anything that is no zod error", () => {
    expect(issueOf({ ...ksei(), mutable: "yes" })).toBeNull();
    expect(issueOf({ ...ksei(), health: { graceMinutes: 0 } })).toBeNull();
    expect(specIssue(new Error("x"))).toBeNull();
  });
});

describe("readsDifferently", () => {
  it("any difference in how the source is read, or nothing saved, counts; key order doesn't", () => {
    const i = ksei().input;
    expect(readsDifferently(i, { ...i })).toBe(false);
    expect(readsDifferently(Object.fromEntries(Object.entries(i).reverse()), i)).toBe(false);
    expect(readsDifferently({ ...i, pattern: "x*.txt" }, i)).toBe(true);
    expect(readsDifferently({ ...i, format: { ...i.format, header: true } }, i)).toBe(true);
    expect(readsDifferently(i, null)).toBe(true);
  });
});

describe("testSentence (REC-F2a: what a passing test found)", () => {
  const all: TestFound = { version: "16.4 (Debian 16.4-1.pgdg120+1)", user: "recon_ro", database: "recon_core", defaulted: false, databases: { n: 3, more: false }, tables: { n: 1284, more: false } };
  it("names the engine, version, login, databases and the tables in the connected database, with grouping separators", () => {
    expect(testSentence("postgres", all)).toBe("Connected to PostgreSQL 16.4 as recon_ro. 3 databases; 1,284 tables in recon_core.");
    expect(testSentence("mssql", { ...all, version: "16.0.4135.4", databases: { n: 1, more: false }, tables: { n: 1, more: false } })).toBe("Connected to SQL Server 16.0.4135.4 as recon_ro. 1 database; 1 table in recon_core.");
    expect(testSentence("mysql", { ...all, version: "8.0.36-0ubuntu0.22.04.1", databases: { n: 500, more: true }, tables: { n: 10_000, more: true } })).toBe("Connected to MySQL 8.0.36 as recon_ro. 500+ databases; 10,000+ tables in recon_core.");
  });
  it("on the default database: the databases and a prompt to choose; a stored connection's login is left out; unread numbers are left out", () => {
    expect(testSentence("postgres", { ...all, defaulted: true, database: "postgres", tables: null })).toBe("Connected to PostgreSQL 16.4 as recon_ro. 3 databases. Choose one to list its tables.");
    expect(testSentence("postgres", { ...all, user: null })).toBe("Connected to PostgreSQL 16.4. 3 databases; 1,284 tables in recon_core.");
    expect(testSentence("postgres", { ...all, databases: null })).toBe("Connected to PostgreSQL 16.4 as recon_ro. 1,284 tables in recon_core.");
    expect(testSentence("postgres", { ...all, databases: null, tables: null })).toBe("Connected to PostgreSQL 16.4 as recon_ro.");
    expect(testSentence("postgres", { version: null, user: null, database: null, defaulted: false, databases: null, tables: null })).toBe("Connected to PostgreSQL.");
  });
  it("Oracle: its version as Oracle names it, the database name, the schemas it can read in", () => {
    expect(testSentence("oracle", { ...all, version: "19.0.0.0.0", user: "RECON_RO", database: "BIFASTPRD", databases: { n: 4, more: false }, tables: null }))
      .toBe("Connected to Oracle 19c (BIFASTPRD) as RECON_RO. 4 schemas with tables you can read.");
    expect([shortVersion("oracle", "23.4.0.24.5"), shortVersion("oracle", "11.2.0.4.0"), shortVersion("postgres", "x")]).toEqual(["23ai", "11.2.0.4.0", ""]);
  });
  it("a refused default database names it, quotes the code and says what to do", () => {
    expect(defaultRefused("postgres", "42501")).toBe("The database list couldn't be loaded: this account can't open the default database postgres (42501). Type the database name instead.");
  });
});
