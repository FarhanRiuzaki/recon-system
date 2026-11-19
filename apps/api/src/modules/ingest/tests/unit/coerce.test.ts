import { describe, expect, it } from "bun:test";
import type { FieldSpec } from "@starterkit/shared/contracts/sources";
import { coerce } from "../../coerce";

const f = (type: FieldSpec["type"], extra: Partial<FieldSpec> = {}): FieldSpec => ({ name: "amount", type, nullable: false, trim: true, ...extra });
const val = (v: string, field: FieldSpec) => {
  const r = coerce(v, field);
  if (!r.ok) throw new Error(r.reason);
  return r.value;
};
const why = (v: string, field: FieldSpec) => {
  const r = coerce(v, field);
  return r.ok ? null : r.reason;
};

describe("decimal (R-5: no floats)", () => {
  const d = f("decimal", { format: { scale: 2 } });
  it("100.5 and 100.50 are the same minor units", () => {
    expect(val("100.5", d)).toBe(10050n);
    expect(val("100.50", d)).toBe(10050n);
    expect(val("100", d)).toBe(10000n);
    expect(val("-0.07", d)).toBe(-7n);
    expect(val("100.500", d)).toBe(10050n);
  });
  it("stays exact where floats cannot", () => {
    expect(val("9007199254740993.01", d)).toBe(900719925474099301n);
    expect(val("0.1", f("decimal", { format: { scale: 18 } }))).toBe(100000000000000000n);
  });
  it("separators come from the field format", () => {
    const id = f("decimal", { format: { scale: 2, decimalSeparator: ",", thousandSeparator: "." } });
    expect(val("1.234.567,8", id)).toBe(123456780n);
    expect(val("1,234,567.8", f("decimal", { format: { scale: 2, thousandSeparator: "," } }))).toBe(123456780n);
  });
  it("rejects what is not a decimal or does not fit the scale, with the column and the value", () => {
    expect(why("12,3x", d)).toBe('amount: not a decimal ("12,3x")');
    expect(why("", d)).toBe("amount is required");
    expect(why("1.234", d)).toBe('amount: more than 2 decimal places ("1.234")');
    expect(why("1e5", d)).toBe('amount: not a decimal ("1e5")');
    expect(why(".", d)).toBe('amount: not a decimal (".")');
  });
});

describe("other types", () => {
  it("integer, boolean, string with trim and case", () => {
    expect(val(" 42 ", f("integer"))).toBe(42n);
    expect(why("4.2", f("integer"))).toBe('amount: not an integer ("4.2")');
    expect(val("Y", f("boolean"))).toBe(true);
    expect(val("0", f("boolean"))).toBe(false);
    expect(why("maybe", f("boolean"))).toBe('amount: not a boolean ("maybe")');
    expect(val(" ab ", f("string", { case: "upper" }))).toBe("AB");
    expect(val(" ab ", f("string", { trim: false }))).toBe(" ab ");
  });
  it("empty: null when nullable, a reason when not", () => {
    expect(coerce("  ", f("string", { nullable: true }))).toEqual({ ok: true, value: null });
    expect(why("  ", f("string"))).toBe("amount is required");
  });
  it("date by pattern, real dates only", () => {
    expect(val("20261102", f("date", { format: { date: "yyyyMMdd" } }))).toBe("2026-11-02");
    expect(val("02/11/2026", f("date", { format: { date: "dd/MM/yyyy" } }))).toBe("2026-11-02");
    expect(val("2026-11-02", f("date"))).toBe("2026-11-02");
    expect(why("2026-02-30", f("date"))).toBe('amount: not a date ("2026-02-30")');
    expect(why("2026/11/02", f("date"))).toBe('amount: not a date ("2026/11/02")');
  });
  it("datetime: the instant in UTC, read in the field's timezone (default Asia/Jakarta)", () => {
    const fmt = { date: "yyyy-MM-dd HH:mm:ss" };
    expect(val("2026-11-02 08:30:00", f("datetime", { format: fmt }))).toBe("2026-11-02T01:30:00.000Z");
    expect(val("2026-11-02 08:30:00", f("datetime", { format: { ...fmt, timezone: "UTC" } }))).toBe("2026-11-02T08:30:00.000Z");
    expect(val("2026-11-02 08:30:00", f("datetime", { format: { ...fmt, timezone: "America/New_York" } }))).toBe("2026-11-02T13:30:00.000Z");
    expect(val("2026-11-02T08:30:00+07:00", f("datetime"))).toBe("2026-11-02T01:30:00.000Z");
    expect(why("2026-11-02 25:00:00", f("datetime", { format: fmt }))).toBe('amount: not a date-time ("2026-11-02 25:00:00")');
  });
});
