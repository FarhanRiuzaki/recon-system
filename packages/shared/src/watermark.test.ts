import { describe, expect, it } from "vitest";
import { SourceSpec } from "./contracts/sources";

const spec = (input: Record<string, unknown>, fields: { name: string; type: string }[] = []) => ({
  fields: [{ name: "d", type: "date", nullable: false, trim: true }, ...fields.map((f) => ({ ...f, nullable: false, trim: false }))],
  mapping: { business_date: { field: "d" }, attrs: {} }, key_fields: [], mutable: false, calendar: "id-default",
  input: { kind: "db_watermark", table: "t", chunk: 100, ...input },
});
const parsed = (input: Record<string, unknown>, fields?: { name: string; type: string }[]) => SourceSpec.safeParse(spec(input, fields));
const messages = (input: Record<string, unknown>, fields?: { name: string; type: string }[]) => (parsed(input, fields).error?.issues ?? []).map((i) => i.message);

describe("the watermark of a pulled source (id columns, look back)", () => {
  it("reads a stored id_column as a one-element id_columns", () => {
    const r = parsed({ watermark: { column: "u", id_column: "id" }, lookback_seconds: 300 });
    expect(r.success).toBe(true);
    expect(r.data!.input).toMatchObject({ watermark: { column: "u", id_columns: ["id"] }, lookback_seconds: 300 });
  });

  it("takes 1 to 4 distinct id columns, in order", () => {
    expect(parsed({ watermark: { column: "u", id_columns: ["branch", "seq"] }, lookback_seconds: 0 }).data?.input).toMatchObject({ watermark: { id_columns: ["branch", "seq"] } });
    expect(parsed({ watermark: { column: "u", id_columns: [] }, lookback_seconds: 0 }).success).toBe(false);
    expect(parsed({ watermark: { column: "u", id_columns: ["a", "b", "c", "d", "e"] }, lookback_seconds: 0 }).success).toBe(false);
    expect(messages({ watermark: { column: "u", id_columns: ["a", "b", "a"] }, lookback_seconds: 0 })).toContain('Id column "a" is picked twice');
    expect(parsed({ watermark: { column: "u", id_column: "id", id_columns: ["id"] }, lookback_seconds: 0 }).success).toBe(false);
  });

  it("looks back in seconds or in ids, never both; ids 0–1,000,000", () => {
    expect(parsed({ watermark: { column: "seq", id_columns: ["id"] }, lookback_ids: 1000 }).success).toBe(true);
    expect(parsed({ watermark: { column: "seq", id_columns: ["id"] } }).success).toBe(true);
    expect(parsed({ watermark: { column: "seq", id_columns: ["id"] }, lookback_ids: 1_000_001 }).success).toBe(false);
    expect(parsed({ watermark: { column: "seq", id_columns: ["id"] }, lookback_ids: -1 }).success).toBe(false);
    expect(messages({ watermark: { column: "u", id_columns: ["id"] }, lookback_seconds: 60, lookback_ids: 10 }))
      .toContain("Look back in seconds (a date or time watermark) or in ids (an integer watermark), not both");
  });

  it("a declared integer watermark looks back in ids, a declared date or time one in seconds", () => {
    expect(messages({ watermark: { column: "seq", id_columns: ["id"] }, lookback_seconds: 60 }, [{ name: "seq", type: "integer" }]))
      .toContain("An integer watermark looks back a number of ids: set the look back in ids, not seconds");
    expect(messages({ watermark: { column: "d", id_columns: ["id"] }, lookback_ids: 10 }))
      .toContain("A date or time watermark looks back in seconds, not ids");
  });
});

describe("a date field's format", () => {
  const withFormat = (type: string, date: string) => SourceSpec.safeParse({
    ...spec({ watermark: { column: "d", id_columns: ["id"] }, lookback_seconds: 86_400 }),
    fields: [{ name: "d", type: "date", nullable: false, trim: true }, { name: "on", type, nullable: true, trim: true, format: { date } }],
  });
  it("is written with yyyy, MM and dd; Oracle's YYYY-MM-DD is refused on that field, saying how to write it", () => {
    for (const ok of ["yyyy-MM-dd", "yyyyMMdd", "dd/MM/yyyy", "yyyy-MM-dd HH:mm:ss"]) expect(withFormat("date", ok).success).toBe(true);
    for (const bad of ["YYYY-MM-DD", "DD/MM/YYYY", "yyyy-mm-dd"]) {
      const issue = withFormat("date", bad).error?.issues.find((i) => i.path.join(".") === "fields.1.format.date");
      expect(issue?.message).toContain(`Date format "${bad}" can't be read`);
    }
    expect(withFormat("datetime", "YYYY-MM-DD HH:mm:ss").success).toBe(false);
    // a format left on a text field reads nothing and refuses nothing
    expect(withFormat("string", "YYYY-MM-DD").success).toBe(true);
  });
});
