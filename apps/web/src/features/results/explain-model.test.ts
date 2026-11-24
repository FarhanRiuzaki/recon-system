import { describe, expect, it } from "vitest";
import { differences, explainFields, sideTotal, totalsDiffer } from "./explain-model";

const rec = (values: Record<string, string | null>, currency: string | null = "IDR") => ({ values, currency, amountMinor: values.amount_minor ?? null });

describe("Explain head to head: one row per field across both sides", () => {
  it("side A's fields in its order, then side B's it lacks, so the same field sits on the same row", () => {
    const a = [{ key: "ext_ref", label: "Reference" }, { key: "amount_minor", label: "Amount" }, { key: "attrs.merchant", label: "Merchant" }];
    const b = [{ key: "ext_ref", label: "Reference" }, { key: "amount_minor", label: "Amount" }, { key: "attrs.settlement_ref", label: "Settlement ref" }];
    expect(explainFields(a, b).map((f) => f.key)).toEqual(["ext_ref", "amount_minor", "attrs.merchant", "attrs.settlement_ref"]);
    expect(explainFields([], b)).toEqual(b);
  });
});

describe("Explain differences (the break page's compare: amount, date, reference)", () => {
  it("one record a side: a field both have and that differs is marked; one missing on a side is not", () => {
    const a = rec({ ext_ref: "P1", amount_minor: "10000", business_date: "2026-11-02", event_time: "2026-11-02T01:00:00Z" });
    const b = rec({ ext_ref: "P1", amount_minor: "9000", business_date: "2026-11-02", event_time: "2026-11-02T03:00:00Z" });
    expect([...differences([a], [b])]).toEqual(["amount_minor"]);
    expect([...differences([a], [rec({ ext_ref: null, amount_minor: "10000", business_date: "2026-11-03" })])]).toEqual(["business_date"]);
  });
  it("the same amount in another currency differs", () => {
    expect([...differences([rec({ amount_minor: "500" }, "IDR")], [rec({ amount_minor: "500" }, "EUR")])]).toEqual(["amount_minor"]);
  });
  it("several records on a side, or none: no field is compared record to record", () => {
    const one = rec({ ext_ref: "P1", amount_minor: "100" });
    expect(differences([one, one], [rec({ ext_ref: "Q", amount_minor: "200" })]).size).toBe(0);
    expect(differences([one], []).size).toBe(0);
  });
});

describe("Explain side totals", () => {
  it("the signed sum in the side's currency; a record without one adds none; Mixed over currencies", () => {
    expect(sideTotal([rec({ amount_minor: "10000" }), rec({ amount_minor: "-500" }, null)])).toEqual({ amount: "9500", currency: "IDR", mixed: false });
    expect(sideTotal([rec({ amount_minor: "1" }, "IDR"), rec({ amount_minor: "1" }, "EUR")])).toEqual({ amount: null, currency: null, mixed: true });
  });
  it("totals differ when the amounts or currencies differ; Mixed is never compared", () => {
    expect(totalsDiffer({ amount: "100", currency: "IDR", mixed: false }, { amount: "90", currency: "IDR", mixed: false })).toBe(true);
    expect(totalsDiffer({ amount: "100", currency: "IDR", mixed: false }, { amount: "100", currency: "IDR", mixed: false })).toBe(false);
    expect(totalsDiffer({ amount: null, currency: null, mixed: true }, { amount: "100", currency: "IDR", mixed: false })).toBe(false);
  });
});
