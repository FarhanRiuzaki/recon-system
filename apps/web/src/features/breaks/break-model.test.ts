import { describe, expect, it } from "vitest";
import type { BreakDetailDto, BreakItemDto } from "@starterkit/shared/contracts/breaks";
import { amountDelta, checkedAgain, combined, sidesOf, compareRows, counterpartOf, dayDelta, findToggled, picksAfter, recheckText, routeBlocked, routeText, routeWarning, settleActions, takeText, workAccess } from "./break-model";

const item = (o: Partial<BreakItemDto> = {}): BreakItemDto => ({
  id: "a1", side: "a", businessDate: "2026-11-02", status: "break", reason: "No counterpart", ref: "P1", amountMinor: "3607350000", currency: "IDR", eventTime: null, source: "Core banking",
  direction: null, ...o, signedMinor: o.signedMinor !== undefined ? o.signedMinor : o.amountMinor !== undefined ? o.amountMinor : "3607350000",
});
const debit = (amount: string, o: Partial<BreakItemDto> = {}) => item({ amountMinor: amount, signedMinor: `-${amount}`, direction: "debit", ...o });
const route = (kind: BreakDetailDto["recon"]["routes"][number]["kind"], o: object = {}) => ({ kind, workflowName: null, levels: 1, connector: null, connectorOff: false, blocked: null, note: null, ...o });
const recon = (o: Partial<BreakDetailDto["recon"]> = {}): BreakDetailDto["recon"] => ({
  id: "r", name: "BI-FAST", sides: ["Core banking", "BI-FAST"], posts: true, carryOverDays: 1, recheck: { kind: "until", date: "2026-11-03" },
  routes: [route("posting", { workflowName: "Treasury head", levels: 2, connector: "Bank Mega" }), route("force_match"), route("write_off"), route("unmatch")], ...o,
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
  it("one counterpart or several show the same way: the unsigned net, and the direction the net counts as", () => {
    expect(combined([item({ amountMinor: "15000", direction: "credit" }), debit("5000")])).toMatchObject({ amountMinor: "10000", direction: "credit" });
    // a side whose amount_sign negates: the net's sign is that of its credits, so it is still a credit
    const neg = (amount: string, direction: "debit" | "credit") => item({ amountMinor: amount, signedMinor: direction === "credit" ? `-${amount}` : amount, direction });
    expect(combined([neg("15000", "credit"), neg("5000", "debit")])).toMatchObject({ amountMinor: "10000", signedMinor: "-10000", direction: "credit" });
    expect(combined([neg("5000", "credit"), neg("15000", "debit")])).toMatchObject({ amountMinor: "10000", direction: "debit" });
    expect(combined([neg("5000", "credit")])).toMatchObject({ amountMinor: "5000", direction: "credit" });
  });
  it("a group with members on both sides compares side totals: this item with its side's members against the other side", () => {
    const a1 = item({ id: "a1", amountMinor: "10000" }), a2 = item({ id: "a2", ref: "P2", amountMinor: "5000" }), b1 = item({ id: "b1", side: "b", ref: "Q1", amountMinor: "15000" });
    const { mine, theirs } = sidesOf(a1, [a2, b1]);
    expect([mine.amountMinor, theirs?.amountMinor]).toEqual(["15000", "15000"]);
    expect(compareRows(mine, theirs!).find((r) => r.label === "Amount")).toMatchObject({ delta: "Same", differs: false });
    // only the other side's items: this item alone against them
    expect(sidesOf(a1, [b1]).mine).toBe(a1);
    expect(sidesOf(a1, [a2]).theirs).toBeNull();
  });
  it("Direction shows only when the directions differ, not when only the signs do", () => {
    const negated = item({ id: "b1", side: "b", direction: "credit", signedMinor: "-3607350000" });
    expect(compareRows(item({ direction: "credit" }), negated).some((r) => r.label === "Direction")).toBe(false);
    expect(compareRows(item({ direction: "credit" }), item({ id: "b1", side: "b", direction: null })).some((r) => r.label === "Direction")).toBe(false);
  });
});

describe("words of the page", () => {
  it("whether runs check the item again, in past tense once its last day has gone", () => {
    expect(recheckText({ kind: "until", date: "2026-11-03" }, "2026-11-03")).toBe("Checked again on each run until 3 Nov");
    expect(recheckText({ kind: "until", date: "2026-11-03" }, "2026-11-04")).toBe("Checked again until 3 Nov; no longer checked");
    expect(recheckText({ kind: "always" }, "2026-11-04")).toBe("Checked again on each run until it matches or is settled");
    expect(recheckText({ kind: "no" }, "2026-11-04")).toBe("Not checked again – settle it here");
    // a request that waits holds it out of the runs; settling here is not what is next
    expect(recheckText({ kind: "no" }, "2026-11-04", true)).toBe("Not checked again while a request waits");
  });
  it("checked again from today: carry over always, or not over yet; the API's checked filter agrees", () => {
    expect(checkedAgain({ kind: "always" }, "2026-11-04")).toBe(true);
    expect(checkedAgain({ kind: "until", date: "2026-11-04" }, "2026-11-04")).toBe(true);
    expect(checkedAgain({ kind: "until", date: "2026-11-03" }, "2026-11-04")).toBe(false);
    expect(checkedAgain({ kind: "no" }, "2026-11-04")).toBe(false);
  });
  it("where a request goes: the connector it calls, or that it is turned off as a warning; only a refused route blocks", () => {
    expect(routeText(recon(), "posting")).toBe("Sent through Bank Mega");
    expect(routeText(recon(), "write_off")).toBeNull();
    const off = recon({ routes: [route("posting", { connector: "Bank Mega", connectorOff: true }), route("write_off", { blocked: "The workflow is gone." })] });
    expect(routeText(off, "posting")).toBeNull();
    expect(routeWarning(off, "posting")).toBe("Bank Mega is turned off: the posting waits as not sent until it is on again");
    expect(routeBlocked(off, "posting")).toBeNull();
    expect(routeBlocked(off, "write_off")).toBe("The workflow is gone.");
    expect(routeBlocked(recon(), "posting")).toBeNull();
  });
});

describe("who works the item", () => {
  const base = { lead: false, operator: true, mine: false, assignee: null, open: true, pending: false };
  it("an operator takes an unassigned item first; Take is then the only next step", () => {
    expect(workAccess(base)).toEqual({ worker: true, canWork: false, take: "first", blocked: "Take this item first." });
    expect(takeText("first")).toBe("Step 1 · Take this item. Whoever has it settles it; it shows as yours in Unmatch.");
  });
  it("a lead works an unassigned item as it is; Take is offered beside, not first", () => {
    expect(workAccess({ ...base, lead: true, operator: false })).toEqual({ worker: true, canWork: true, take: "offer", blocked: null });
    expect(takeText("offer")).toBe("Nobody has this item. You can settle it as it is, or take it so it shows as yours in Unmatch.");
  });
  it("someone else's item: an operator waits, a lead works it; nobody is offered Take", () => {
    expect(workAccess({ ...base, assignee: "Ana" })).toMatchObject({ canWork: false, take: null, blocked: "Ana has this item. A reviewer or space admin can reassign it from Unmatch." });
    expect(workAccess({ ...base, lead: true, assignee: "Ana" })).toMatchObject({ canWork: true, take: null, blocked: null });
    expect(workAccess({ ...base, mine: true, assignee: "Me" })).toMatchObject({ canWork: true, take: null, blocked: null });
  });
});

describe("what the summary compares", () => {
  const proposed = { item: item({ id: "p1", side: "b", ref: "Q9" }), pass: 3, available: true };
  const none = { request: null, matchedWith: [], proposed: null, open: true, picked: [] };
  it("the ticked items once anything is ticked, never the proposed pair behind them", () => {
    const picked = [item({ id: "b1", side: "b" }), item({ id: "b2", side: "b" })];
    expect(counterpartOf({ ...none, proposed, picked })).toMatchObject({ items: picked, label: "Picked" });
    expect(counterpartOf({ ...none, proposed })).toMatchObject({ items: [proposed.item], label: "Proposed pair", note: "Proposed by pass 3 of a later run." });
    expect(counterpartOf(none)).toBeNull();
  });
  it("closing Find another counterpart clears the ticks; opening keeps them", () => {
    const picked = new Map([["b1", item({ id: "b1" })]]);
    expect(findToggled(picked, false).size).toBe(0);
    expect(findToggled(picked, true)).toBe(picked);
  });
  it("a new proposed pair clears the ticks, so nothing picked against the old one stays hidden behind it", () => {
    const picked = new Map([["b1", item({ id: "b1" })]]);
    expect(picksAfter(picked, "p1", "p2").size).toBe(0);
    expect(picksAfter(picked, "p1", null).size).toBe(0);
    expect(picksAfter(picked, "p1", "p1")).toBe(picked);
  });
});

describe("what you can do", () => {
  const access = { worker: true, canWork: true, take: null, blocked: null } as const;
  const base = { recon: recon(), access, target: { kind: "none" } as const };
  it("in order, with one primary: Request posting when the recon posts", () => {
    const a = settleActions(base);
    expect(a.map((x) => x.key)).toEqual(["posting", "match", "force", "writeOff", "close"]);
    expect(a.filter((x) => x.primary).map((x) => x.key)).toEqual(["posting"]);
    expect(a.find((x) => x.key === "match")!.blocked).toBe("Pick the counterpart below first.");
  });
  it("without posting the proposed pair is the primary; nothing is primary while the item must be taken first", () => {
    const a = settleActions({ ...base, recon: recon({ posts: false }), target: { kind: "proposed" } });
    expect(a.map((x) => x.key)).toEqual(["match", "force", "writeOff", "close"]);
    expect(a.filter((x) => x.primary).map((x) => x.key)).toEqual(["match"]);
    const taken = settleActions({ ...base, access: { ...access, canWork: false, take: "first", blocked: "Take this item first." } });
    expect(taken.every((x) => x.blocked === "Take this item first." && !x.primary)).toBe(true);
  });
  it("a lead on an unassigned item has one primary in the cards (Take is secondary)", () => {
    const a = settleActions({ ...base, access: { ...access, take: "offer" } });
    expect(a.filter((x) => x.primary)).toHaveLength(1);
  });
  it("Match and Force match name what they act on and say so in their consequence", () => {
    const picked = settleActions({ ...base, target: { kind: "picked", count: 2 } });
    expect(picked.find((x) => x.key === "match")).toMatchObject({ blocked: null, label: "Match with 2 picked items" });
    expect(picked.find((x) => x.key === "force")).toMatchObject({ label: "Force match with 2 picked items", consequence: "Matches it with the 2 items you picked although the totals differ. A reviewer or space admin approves first." });
    expect(settleActions({ ...base, target: { kind: "picked", count: 1 } }).find((x) => x.key === "match")!.label).toBe("Match with picked item");
    const pair = settleActions({ ...base, target: { kind: "proposed" } });
    expect(pair.find((x) => x.key === "match")!.label).toBe("Match pair");
    expect(pair.find((x) => x.key === "force")).toMatchObject({ label: "Force match pair", consequence: "Matches it with the proposed pair although the totals differ. A reviewer or space admin approves first." });
  });
  it("each request names who approves it, from its route; a blocked route blocks its button", () => {
    const a = settleActions(base);
    expect(a.find((x) => x.key === "posting")).toMatchObject({ consequence: "It goes for approval: Treasury head, 2 levels approves. On the final approval it closes as posted and is sent to the bank.", meta: "Sent through Bank Mega" });
    expect(a.find((x) => x.key === "writeOff")!.consequence).toBe("Closes it as written off once a reviewer or space admin approves.");
    expect(a.find((x) => x.key === "close")!.meta).toBeUndefined();
    // a turned-off connector warns but never blocks: the server takes the request and the posting waits
    const off = settleActions({ ...base, recon: recon({ routes: [route("posting", { connector: "Bank Mega", connectorOff: true }), route("write_off", { connector: "Bank Mega", connectorOff: true })] }), target: { kind: "proposed" } });
    expect(off.find((x) => x.key === "posting")).toMatchObject({ blocked: null, primary: true, meta: undefined, warning: "Bank Mega is turned off: the posting waits as not sent until it is on again" });
    expect(off.find((x) => x.key === "writeOff")!.blocked).toBeNull();
    // a gone workflow blocks only when no rule could pick another; with rules it is checked on sending
    const gone = settleActions({ ...base, recon: recon({ routes: [route("posting", { connector: "Bank Mega" }), route("write_off", { blocked: "The workflow is gone." }), route("force_match", { note: "The workflow depends on the item; checked when you send it." })] }) });
    expect(gone.find((x) => x.key === "writeOff")!.blocked).toBe("The workflow is gone.");
    expect(gone.find((x) => x.key === "force")).toMatchObject({ meta: "The workflow depends on the item; checked when you send it." });
  });
});
