import { describe, expect, it } from "vitest";
import { amountTile } from "@/lib/shared/amount";

describe("unmatch KPI tray: the open amount tile (audit Q1)", () => {
  it("the largest currency as the value, the others in the caption; none open is 0", () => {
    expect(amountTile([{ currency: "IDR", amountMinor: "3500000" }, { currency: "EUR", amountMinor: "500" }])).toEqual({ value: "35,000.00", unit: "IDR", caption: "Also 5.00 EUR" });
    expect(amountTile([{ currency: "IDR", amountMinor: "100" }])).toEqual({ value: "1.00", unit: "IDR", caption: undefined });
    expect(amountTile([])).toEqual({ value: "0" });
  });
});
