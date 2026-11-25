import { describe, expect, it } from "vitest";
import { SourceSpec } from "./sources";

const spec = (mapping: Record<string, unknown>) => ({
  fields: [{ name: "d", type: "date", nullable: false, trim: true }, { name: "n", type: "string", nullable: true, trim: true }],
  mapping: { business_date: { field: "d" }, ...mapping }, key_fields: [], mutable: false, calendar: "id-default",
  input: { kind: "db_watermark", table: "t", watermark: { column: "u", id_columns: ["id"] }, lookback_seconds: 0, chunk: 100 },
});

describe("customer data in a source's mapping", () => {
  it("names attributes of the mapping; none by default; another name is refused", () => {
    expect(SourceSpec.parse(spec({ attrs: { name: { field: "n" } } })).mapping.customer ?? []).toEqual([]);
    expect(SourceSpec.safeParse(spec({ attrs: { name: { field: "n" } }, customer: ["name"] })).success).toBe(true);
    expect(SourceSpec.safeParse(spec({ attrs: {}, customer: ["name"] })).error?.issues[0]?.message).toBe("Mark only an extra attribute of this source as customer data.");
  });
});
