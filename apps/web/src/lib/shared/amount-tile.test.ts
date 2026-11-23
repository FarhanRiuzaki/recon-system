import { describe, expect, it } from "vitest";
import { amountTile, majorAmount } from "@/lib/shared/amount";

describe("unmatch KPI tray: the open amount tile (audit Q1)", () => {
  it("the largest currency as the value, the others in the caption; none open is 0", () => {
    expect(amountTile([{ currency: "IDR", amountMinor: "3500000" }, { currency: "EUR", amountMinor: "500" }])).toEqual({ value: "35,000.00", unit: "IDR", caption: "Also 5.00 EUR" });
    expect(amountTile([{ currency: "IDR", amountMinor: "100" }])).toEqual({ value: "1.00", unit: "IDR", caption: undefined });
    expect(amountTile([])).toEqual({ value: "0" });
  });
});

describe("the unmatch amount filter: text typed in major units, as the API takes it", () => {
  it("digits and one point; separators and signs dropped; nothing without a digit", () => {
    expect(majorAmount("1,000.50")).toBe("1000.50");
    expect(majorAmount(" 1 000 ")).toBe("1000");
    expect(majorAmount("-25")).toBe("25");
    expect(majorAmount("1.2.3")).toBe("1.23");
    expect(majorAmount("12.")).toBe("12.");
    expect(majorAmount(".")).toBe("");
    expect(majorAmount("abc")).toBe("");
    expect(majorAmount("1234567890123456789.1234567")).toBe("123456789012345.123456");
  });
});
