import { describe, expect, it } from "vitest";
import type { BreakDetailDto, BreakItemDto } from "@starterkit/shared/contracts/breaks";
import { amountDelta, combined, compareRows, dayDelta, recheckText, routeText, settleActions } from "./break-model";

const item = (o: Partial<BreakItemDto> = {}): BreakItemDto => ({
  id: "a1", side: "a", businessDate: "2026-11-02", status: "break", reason: "No counterpart", ref: "P1", amountMinor: "3607350000", currency: "IDR", eventTime: null, source: "Core banking",
  direction: null, ...o, signedMinor: o.signedMinor !== undefined ? o.signedMinor : o.amountMinor !== undefined ? o.amountMinor : "3607350000",
});
const debit = (amount: string, o: Partial<BreakItemDto> = {}) => item({ amountMinor: amount, signedMinor: `-${amount}`, direction: "debit", ...o });
const route = (kind: BreakDetailDto["recon"]["routes"][number]["kind"], o: object = {}) => ({ kind, workflowName: null, levels: 1, connector: null, ...o });
const recon = (o: Partial<BreakDetailDto["recon"]> = {}): BreakDetailDto["recon"] => ({
  id: "r", name: "BI-FAST", sides: ["Core banking", "BI-FAST"], posts: true, carryOverDays: 1, recheck: { kind: "until", date: "2026-11-03" },
  routes: [route("posting", { workflowName: "Two levels", levels: 2, connector: "Bank Mega" }), route("force_match"), route("write_off"), route("unmatch")], ...o,
});

describe("the difference between this item and its counterpart", () => {
  it("amount: the counterpart minus this item in the item's currency, Same when equal, none across currencies or without an amount", () => {
    expect(amountDelta(item({ amountMinor: "10000" }), item({ amountMinor: "10100" }))).toBe("+1.00 IDR");
    expect(amountDelta(item({ amountMinor: "10000" }), item({ amountMinor: "9900" }))).toBe("−1.00 IDR");
    expect(amountDelta(item(), item())).toBe("Same");
    expect(amountDelta(item(), item({ currency: "EUR" }))).toBe("Another currency");
    expect(amountDelta(item({ amountMinor: null }), item())).toBeNull();
  });
  it("amount: on the signed amounts the totals compare, so a credit and a debit of one amount are not the same", () => {
    expect(amountDelta(item({ amountMinor: "10000", direction: "credit" }), debit("10000"))).toBe("−200.00 IDR");
    const rows = compareRows(item({ amountMinor: "10000", direction: "credit" }), debit("10000", { id: "b1", side: "b" }));
    expect(rows.find((r) => r.label === "Amount")).toMatchObject({ a: "100.00 IDR", b: "100.00 IDR", differs: true });
    expect(rows.find((r) => r.label === "Direction")).toMatchObject({ a: "Credit", b: "Debit", differs: true });
    // the same direction needs no hint
    expect(compareRows(item(), item({ id: "b1" })).some((r) => r.label === "Direction")).toBe(false);
  });
  it("business date: days between, Same day when equal", () => {
    expect(dayDelta("2026-11-02", "2026-11-03")).toBe("+1 day");
    expect(dayDelta("2026-11-05", "2026-11-02")).toBe("−3 days");
    expect(dayDelta("2026-11-02", "2026-11-02")).toBe("Same day");
  });
  it("rows mark what differs; a reference always differs in kind, so it is never marked", () => {
    const rows = compareRows(item(), item({ id: "b1", side: "b", ref: "Q1", businessDate: "2026-11-03", source: "BI-FAST" }));
    expect(rows.map((r) => [r.label, r.differs, r.delta ?? null])).toEqual([
      ["Reference", false, null], ["Amount", false, "Same"], ["Business date", true, "+1 day"], ["Source", false, null],
    ]);
  });
  it("several counterparts compare as one: their total, the latest date, the first reference and how many more", () => {
    const c = combined([item({ id: "b1", ref: "Q1", amountMinor: "100" }), item({ id: "b2", ref: "Q2", amountMinor: "50", businessDate: "2026-11-04" })]);
    expect(c).toMatchObject({ ref: "Q1 and 1 more", amountMinor: "150", businessDate: "2026-11-04" });
    expect(combined([item({ currency: "IDR" }), item({ currency: "EUR" })])?.amountMinor).toBeNull();
    // a credit of 150 and a debit of 50 net 100
    expect(combined([item({ amountMinor: "15000" }), debit("5000")])).toMatchObject({ amountMinor: "10000", signedMinor: "10000" });
    expect(combined([])).toBeNull();
  });
});

describe("words of the page", () => {
  it("whether runs check the item again, in past tense once its last day has gone", () => {
    expect(recheckText({ kind: "until", date: "2026-11-03" }, "2026-11-03")).toBe("Checked again on each run until 3 Nov");
    expect(recheckText({ kind: "until", date: "2026-11-03" }, "2026-11-04")).toBe("Checked again until 3 Nov; no longer checked");
    expect(recheckText({ kind: "always" }, "2026-11-04")).toBe("Checked again on each run until it matches or is settled");
    expect(recheckText({ kind: "no" }, "2026-11-04")).toBe("Not checked again — settle it here");
  });
  it("where a request goes: the workflow or the default chain, its levels, the connector", () => {
    expect(routeText(recon(), "posting")).toBe("Two levels · 2 levels · sent through Bank Mega");
    expect(routeText(recon(), "write_off")).toBe("Default chain · 1 level");
    expect(routeText(recon({ routes: [] }), "write_off")).toBeNull();
  });
});

describe("what you can do", () => {
  const base = { recon: recon(), blocked: null, target: { proposed: false, count: 0 } };
  it("in order, with one primary: Request posting when the recon posts", () => {
    const a = settleActions(base);
    expect(a.map((x) => x.key)).toEqual(["posting", "match", "force", "writeOff", "close"]);
    expect(a.filter((x) => x.primary).map((x) => x.key)).toEqual(["posting"]);
    expect(a.find((x) => x.key === "match")!.blocked).toBe("Pick the counterpart below first.");
  });
  it("without posting the proposed pair is the primary; nothing is primary while the item must be taken first", () => {
    const a = settleActions({ ...base, recon: recon({ posts: false }), target: { proposed: true, count: 1 } });
    expect(a.map((x) => x.key)).toEqual(["match", "force", "writeOff", "close"]);
    expect(a.filter((x) => x.primary).map((x) => x.key)).toEqual(["match"]);
    const taken = settleActions({ ...base, blocked: "Take this item first." });
    expect(taken.every((x) => x.blocked === "Take this item first." && !x.primary)).toBe(true);
  });
  it("each says its consequence and, for a request, where it goes", () => {
    const a = settleActions({ ...base, target: { proposed: false, count: 2 } });
    expect(a.find((x) => x.key === "posting")!.meta).toBe("Two levels · 2 levels · sent through Bank Mega");
    expect(a.find((x) => x.key === "match")).toMatchObject({ blocked: null, label: "Match 2 items" });
    expect(a.find((x) => x.key === "force")!.meta).toBe("Default chain · 1 level");
    expect(a.find((x) => x.key === "close")!.meta).toBeUndefined();
  });
});
