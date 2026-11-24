import { describe, expect, it } from "vitest";
import type { SourceSpec } from "@starterkit/shared/contracts/sources";
import { type Draft, EMPTY_CONN, emptySpec } from "./model";
import { summaryRows } from "./review";

const wm = (input: Partial<Extract<SourceSpec["input"], { kind: "db_watermark" }>>, keep?: SourceSpec["keep"]): Draft => {
  const spec = emptySpec("db_watermark");
  return {
    name: "Core", code: "core", kind: "db_watermark", conn: EMPTY_CONN, from: "table",
    spec: { ...spec, fields: [{ name: "u", type: "date", nullable: false, trim: false }], mapping: { ...spec.mapping, business_date: { field: "u" } }, ...(keep ? { keep } : {}),
      input: { kind: "db_watermark", table: "t", watermark: { column: "u", id_columns: ["u"] }, chunk: 2000, when: { every_minutes: 15 }, ...input } },
  };
};
const value = (rows: ReturnType<typeof summaryRows>, label: string) => rows.find((r) => r.label === label);

describe("the review step lists every setting the checker approves (maker-checker)", () => {
  it("a watermark pull: when to read, the look back (its default named) and rows per page, editable on step 1 by a source admin only", () => {
    const admin = summaryRows(wm({}), true, "date");
    expect(value(admin, "When to read")).toEqual({ label: "When to read", value: "Every 15 minutes", step: 0 });
    expect(value(admin, "Look back")?.value).toBe("1 day (default)");
    expect(value(admin, "Rows per page")?.value).toBe("2,000");
    // a config maker sees them too, without Change (the connection step is a source admin's)
    expect(value(summaryRows(wm({}), false, "date"), "Look back")).toEqual({ label: "Look back", value: "1 day (default)" });
  });
  it("a snapshot's query and schedule; rows to load", () => {
    const d = wm({}, [{ field: "u", op: "is_null" }]);
    const snap: Draft = { ...d, kind: "db_snapshot", spec: { ...d.spec, input: { kind: "db_snapshot", query: "SELECT * FROM t WHERE d = :business_date", schedule: "0 6 * * *" } } };
    const rows = summaryRows(snap, true, null);
    expect(value(rows, "Query")?.value).toBe("SELECT * FROM t WHERE d = :business_date");
    expect(value(rows, "Schedule")?.value).toBe("Daily at 06:00 WIB");
    expect(value(rows, "Rows to load")?.value).toBe("u is empty");
  });
});
