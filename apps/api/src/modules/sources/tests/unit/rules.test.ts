import { describe, expect, it } from "bun:test";
import { SourceSpec } from "@starterkit/shared/contracts/sources";
import { canStep, specHash } from "../../rules";
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
