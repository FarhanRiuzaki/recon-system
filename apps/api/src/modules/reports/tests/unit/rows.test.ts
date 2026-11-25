// The pure parts of report rows: masking customer data, grouping with totals, and the daily summary.
import { describe, expect, it } from "bun:test";
import { maskValue } from "../../mask";
import { dailySummary, groupRows, type ReportRow } from "../../summary";

describe("maskValue", () => {
  it("keeps the last four, dots for the rest; four or fewer are all dots", () => {
    expect(maskValue("1234567890")).toBe("······7890");
    expect(maskValue("1234")).toBe("····");
    expect(maskValue("")).toBe("");
  });
});

const row = (o: Partial<ReportRow>): ReportRow => ({ date: "2026-11-02", status: "matched", values: {}, amount: null, currency: null, reason: null, ...o });

describe("groupRows", () => {
  it("groups by one or two columns, each group with its totals, then a grand total", () => {
    const rows = [row({ values: { "recon:reason": "No counterpart", "a:amount_minor": "10" } }), row({ values: { "recon:reason": "No counterpart", "a:amount_minor": "5" } }), row({ values: { "recon:reason": "Amount differs", "a:amount_minor": "2" } })];
    const out = groupRows(rows, ["recon:reason"], [{ fn: "count" }, { fn: "sum", column: "a:amount_minor" }]);
    expect(out.map((r) => [r.kind, r.label, r.totals])).toEqual([
      ["group", "Amount differs", [1, 2]], ["row", null, null],
      ["group", "No counterpart", [2, 15]], ["row", null, null], ["row", null, null],
      ["total", "Total", [3, 17]],
    ]);
  });
});

describe("dailySummary", () => {
  it("per date: rows per status, matched and breaks, match rate without not required, amounts per currency, breaks per reason", () => {
    const s = dailySummary([
      row({ status: "matched", amount: 100n, currency: "IDR" }), row({ status: "unmatch", amount: 40n, currency: "IDR", reason: "No counterpart" }),
      row({ status: "unmatch", amount: 5n, currency: "USD", reason: "No counterpart" }), row({ status: "not_required" }),
      row({ date: "2026-11-03", status: "matched", amount: 1n, currency: "IDR" }),
    ]);
    expect(s.map((d) => d.date)).toEqual(["2026-11-02", "2026-11-03"]);
    expect(s[0]).toMatchObject({ total: 4, matched: 1, breaks: 2, matchRate: 1 / 3, byStatus: { matched: 1, unmatch: 2, not_required: 1 } });
    expect(s[0]!.amounts).toEqual([{ currency: "IDR", matched: 100n, breaks: 40n }, { currency: "USD", matched: 0n, breaks: 5n }]);
    expect(s[0]!.breaksByReason).toEqual([{ reason: "No counterpart", count: 2 }]);
  });
});

describe("groupRows with masked values", () => {
  it("groups by the real value and shows the masked one: two accounts ending alike stay two groups", () => {
    const a = row({ values: { "a:account_ref": "····1234" }, raw: { "a:account_ref": "1111111234" } });
    const b = row({ values: { "a:account_ref": "····1234" }, raw: { "a:account_ref": "2222221234" } });
    const out = groupRows([a, b], ["a:account_ref"], [{ fn: "count" }]);
    expect(out.filter((r) => r.kind === "group").map((r) => [r.label, r.totals])).toEqual([["····1234", [1]], ["····1234", [1]]]);
  });
});
