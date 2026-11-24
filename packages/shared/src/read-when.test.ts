import { describe, expect, it } from "vitest";
import { readCron, readWhenText } from "./sources";

describe("When to read (readCron, readWhenText)", () => {
  it("every N minutes, all day by default", () => {
    expect(readCron(undefined)).toBe("* * * * *");
    expect(readCron({ every_minutes: 5 })).toBe("*/5 * * * *");
    expect(readCron({ every_minutes: 60 })).toBe("0 * * * *");
    expect(readWhenText(undefined)).toBe("every minute");
    expect(readWhenText({ every_minutes: 15 })).toBe("every 15 minutes");
  });
  it("only between whole hours, a window past midnight wrapping", () => {
    expect(readCron({ every_minutes: 5, hours: { from: 6, to: 22 } })).toBe("*/5 6-21 * * *");
    expect(readCron({ hours: { from: 22, to: 6 } })).toBe("* 22-23,0-5 * * *");
    expect(readCron({ hours: { from: 9, to: 10 } })).toBe("* 9 * * *");
    expect(readCron({ hours: { from: 0, to: 24 } })).toBe("* 0-23 * * *");
    expect(readWhenText({ every_minutes: 60, hours: { from: 22, to: 6 } })).toBe("every hour, 22:00–06:00");
  });
});

describe("the spec takes When to read on a pulled or folder source", () => {
  it("only the listed intervals and a window that isn't empty", async () => {
    const { SourceSpec } = await import("./contracts/sources");
    const spec = (when: unknown) => ({
      fields: [{ name: "d", type: "date", nullable: false, trim: true }], mapping: { business_date: { field: "d" }, attrs: {} }, key_fields: [], mutable: false, calendar: "id-default",
      input: { kind: "db_watermark", table: "t", watermark: { column: "u", id_columns: ["id"] }, lookback_seconds: 0, chunk: 100, when },
    });
    expect(SourceSpec.safeParse(spec({ every_minutes: 15, hours: { from: 22, to: 6 } })).success).toBe(true);
    expect(SourceSpec.safeParse(spec({ every_minutes: 7 })).success).toBe(false);
    expect(SourceSpec.safeParse(spec({ hours: { from: 0, to: 24 } })).success).toBe(false);
  });
});
