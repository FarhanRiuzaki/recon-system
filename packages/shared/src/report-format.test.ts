import { describe, expect, it } from "vitest";
import { fitWidth, formatCell } from "./report-format";

const num = (o: Partial<{ decimals: number; thousands: "." | "," | "none"; negative: "minus" | "paren" | "trailing"; prefix: string; suffix: string }> = {}) =>
  ({ kind: "number" as const, decimals: 2, thousands: "." as const, negative: "minus" as const, prefix: "", suffix: "", ...o });

describe("formatCell", () => {
  it("numbers: decimals, thousands, negative style, prefix and suffix", () => {
    expect(formatCell(-1234567.891, num({ negative: "paren", prefix: "Rp " }))).toBe("(Rp 1.234.567,89)");
    expect(formatCell(-1234567.891, num({ thousands: "," }))).toBe("-1,234,567.89");
    expect(formatCell(1234567.891, num({ thousands: "none" }))).toBe("1234567.89");
    expect(formatCell(-1500, num({ decimals: 0, negative: "trailing" }))).toBe("1.500-");
    expect(formatCell(98000000, num({ decimals: 0, suffix: " IDR" }))).toBe("98.000.000 IDR");
    expect(formatCell("12.5", num({ decimals: 1 }))).toBe("12,5");
    expect(formatCell("abc", num())).toBe("abc");
  });
  it("dates by each pattern", () => {
    const d = (pattern: string) => formatCell("2026-11-05", { kind: "date", pattern: pattern as never });
    expect(["dd/MM/yyyy", "yyyy-MM-dd", "yyyyMMdd", "ddMMyyyy", "dd MMM yyyy", "dd-MM-yyyy", "MM/dd/yyyy"].map(d))
      .toEqual(["05/11/2026", "2026-11-05", "20261105", "05112026", "05 Nov 2026", "05-11-2026", "11/05/2026"]);
    expect(formatCell("2026-11-05T08:30:00.000Z", { kind: "date", pattern: "yyyyMMdd" })).toBe("20261105");
  });
  it("text case, auto, and empty", () => {
    expect(formatCell("Amount differs", { kind: "text", case: "upper" })).toBe("AMOUNT DIFFERS");
    expect(formatCell("ABC", { kind: "text", case: "lower" })).toBe("abc");
    expect(formatCell(12, { kind: "auto" })).toBe("12");
    expect(formatCell(null, num())).toBe("");
  });
});

describe("fitWidth", () => {
  it("cuts to the width and pads by the alignment; zero padding keeps the sign first", () => {
    expect(fitWidth("-1500", { align: "r", width: 8, pad: "0" }, true)).toBe("-0001500");
    expect(fitWidth("1500", { align: "r", width: 8, pad: "0" }, true)).toBe("00001500");
    expect(fitWidth("ABCDEFGHIJ", { align: "l", width: 4, pad: " " }, false)).toBe("ABCD");
    expect(fitWidth("AB", { align: "c", width: 6, pad: " " }, false)).toBe("  AB  ");
    expect(fitWidth("AB", { align: "r", width: 4, pad: "0" }, false)).toBe("  AB");
  });
});
