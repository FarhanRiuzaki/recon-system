import { describe, expect, it, vi } from "vitest";
import type { PassSpec, ReconSpec } from "@starterkit/shared/contracts/recon";
import { amountText, connectorText, countLine, dayPasses, dayTotals, differenceText, itemsText, passOutcome, pastClose, projectionText, rangeText, reasonCount, recordDates, replayEnd, replayGap, suggestedReplay, runDays, runTotals, sidesText, simView, doneChip, standingTotals, breakCounts, carryOverText, counterpartWindow, lonePairText, pairDifference, reasonOptions, breakPair, breaksOf, breaksText, runLine, runRowChips, scopeCaption, readIn, runCurrency } from "./run-model";

// The Plan 3 gate (docs/recon/source-test-db.md "Kunci jawaban"): pass 1 exact with duplicates, passes 2 and 3 suggest.
const pass = (no: number, accept: "auto" | "suggest", blocking: string[] = ["ext_ref"]): PassSpec =>
  ({ no, name: `Pass ${no}`, cardinality: "1:1", blocking, predicates: [{ op: "eq", field: "currency" }], accept, on_ambiguous: "break" }) as PassSpec;
const spec = {
  sides: [{ key: "a", label: "source1" }, { key: "b", label: "source2" }],
  passes: [pass(1, "auto"), pass(2, "suggest"), pass(3, "suggest")],
} as unknown as ReconSpec;
const gate = {
  intake: { a: 1000, b: 1000 }, replaced: { a: 0, b: 0 }, open: { a: 24, b: 24 },
  passes: { 1: { matched: 937, suggested: 0, broken: 30 }, 2: { matched: 0, suggested: 14, broken: 0 }, 3: { matched: 0, suggested: 10, broken: 0 } },
};
const run = { status: "succeeded" as const, mode: "simulation" as const, from: "2026-11-02", to: "2026-11-05", counters: gate, error: null, finishedAt: "2026-11-21T07:22:00Z", specHash: "h1" };

describe("run-model", () => {
  it("writes business date ranges as the design does", () => {
    expect(rangeText("2026-11-02", "2026-11-05")).toBe("2–5 Nov 2026");
    expect(rangeText("2026-11-20", "2026-11-20")).toBe("20 Nov 2026");
    expect(rangeText("2026-10-30", "2026-11-02")).toBe("30 Oct – 2 Nov 2026");
    expect(rangeText("2026-12-30", "2027-01-02")).toBe("30 Dec 2026 – 2 Jan 2027");
  });

  it("counts the dates past close: interval at close_at, daily at its run time offset days later (WIB)", () => {
    const now = Date.parse("2026-11-05T23:10:00+07:00");
    const interval = { close_at: "23:00", schedule: { kind: "interval", every_minutes: 15 } } as unknown as ReconSpec;
    expect(pastClose(interval, { from: "2026-11-02", to: "2026-11-06" }, now)).toBe(4); // 2–5 Nov; 6 Nov not yet
    const daily = { close_at: "23:00", schedule: { kind: "daily", at: "06:00", business_date_offset: 1 } } as unknown as ReconSpec;
    expect(pastClose(daily, { from: "2026-11-02", to: "2026-11-05" }, now)).toBe(3); // 5 Nov closes 6 Nov 06:00
  });

  it("ends a replay after 31 dates or today, whichever is first", () => {
    expect(replayEnd("2026-10-01", "2026-11-21")).toBe("2026-10-31");
    expect(replayEnd("2026-11-10", "2026-11-21")).toBe("2026-11-21");
  });

  it("totals the gate run as the answer key: 937 matched, 24 suggested, 30 duplicate, 24 · 24 waiting, 93.7%", () => {
    const t = runTotals(gate, spec);
    expect(t).toMatchObject({ matched: 937, suggested: 24, duplicate: 30, ambiguous: 0, waiting: { a: 24, b: 24 }, items: 2000 });
    expect(countLine(t, ["source1", "source2"])).toBe("937 matched · 24 suggested (open) · 30 duplicate · 24 waiting per side · match rate 93.7%");
    expect(countLine({ ...t, waiting: { a: 7, b: 8 } }, ["source1", "source2"])).toBe("937 matched · 24 suggested (open) · 30 duplicate · 7 source1 · 8 source2 waiting · match rate 93.7%");
  });

  it("has no match rate when an N:1 pass matched (side A items per group unknown)", () => {
    const n1 = { ...spec, passes: [{ ...pass(1, "auto"), cardinality: "N:1" }] } as ReconSpec;
    expect(runTotals(gate, n1).rate).toBeNull();
  });

  it("says In and Unmatched per side, and no Left after a pass that broke items (no split by side yet)", () => {
    expect(connectorText(gate, spec, 0)).toBe("In: 1,000 source1 · 1,000 source2");
    expect(connectorText(gate, spec, 1)).toBeNull();
    expect(connectorText(gate, spec, 3)).toBe("Unmatched: 24 source1 · 24 source2");
    const clean = { ...gate, passes: { ...gate.passes, 1: { matched: 937, suggested: 0, broken: 0 } } };
    expect(connectorText(clean, spec, 2)).toBe("Left: 49 source1 · 49 source2");
  });

  it("with per-side counts: the funnel adds up per side after the duplicates, the duplicate names its references", () => {
    const side = (n: number) => ({ a: n, b: n });
    const full = { ...gate, passes: {
      1: { matched: 937, suggested: 0, broken: 30, brokenRefs: 10, matchedItems: side(937), suggestedItems: side(0), brokenItems: side(15) },
      2: { matched: 0, suggested: 14, broken: 0, brokenRefs: 0, matchedItems: side(0), suggestedItems: side(14), brokenItems: side(0) },
      3: { matched: 0, suggested: 10, broken: 0, brokenRefs: 0, matchedItems: side(0), suggestedItems: side(10), brokenItems: side(0) },
    } };
    expect(connectorText(full, spec, 1)).toBe("Left: 48 source1 · 48 source2  (1,000 = 937 matched + 15 duplicate + 48 left, per side)");
    expect(connectorText(full, spec, 2)).toBe("Left: 34 source1 · 34 source2");
    expect(passOutcome(full, spec, spec.passes[0]!)[1]).toMatchObject({ tag: "Duplicate", count: "10 refs · 30 items" });
    expect(runTotals(full, spec)).toMatchObject({ duplicateRefs: 10, rate: 0.937 });
  });

  it("gives each pass its outcomes; Duplicate is its own, never inside Matched", () => {
    expect(passOutcome(gate, spec, spec.passes[0]!)).toEqual([
      { tag: "Matched", tone: "neutral", count: "937 pairs", note: "93.7% of source1 items in" },
      { tag: "Duplicate", tone: "warn", count: "30 items", note: "need review" },
    ]);
    expect(passOutcome(gate, spec, spec.passes[1]!)).toEqual([{ tag: "Suggested", tone: "neutral", count: "14 pairs", note: "open until accepted" }]);
    expect(passOutcome(gate, { ...spec, passes: [pass(1, "auto", [])] } as ReconSpec, { ...pass(1, "auto", []), predicates: [{ op: "date_window", field: "business_date", days: 1 }] } as PassSpec)[1]?.tag).toBe("Ambiguous");
  });

  it("states the simulation bar: not simulated, running, simulated, out of date, stopped", () => {
    const v = { version: 1, matchingHash: "h1", simulatedHash: "h1" };
    // a finished run or simulation worked: green (owner 24 Nov, superseding audit S5's neutral Simulated)
    expect([doneChip("daily"), doneChip("simulation")]).toEqual([{ health: "healthy", label: "Done" }, { health: "healthy", label: "Simulated" }]);
    expect(simView({ ...v, simulatedHash: null }, null, null, false).chip.health).toBe("degraded");
    expect(simView({ ...v, simulatedHash: null }, null, null, false).chip.label).toBe("Not simulated");
    expect(simView({ ...v, simulatedHash: null }, null, null, false).line).toBe("Draft v1 · not simulated yet");
    const s = simView(v, run, run, false);
    expect(s.chip).toEqual({ health: "healthy", label: "Simulated" });
    expect(s.line).toBe("Draft v1 · 2–5 Nov 2026 · 2,000 items · 14:22 WIB");
    // a simulation over dates without a record finished but proved nothing: amber, and never the word Done, which is
    // green everywhere else (review 24 Nov), nor a plain Simulated (S5)
    const none = { ...run, counters: { ...run.counters, intake: { a: 0, b: 0 }, replaced: { a: 0, b: 0 } } };
    expect(simView(v, none, none, false)).toMatchObject({ chip: { health: "degraded", label: "No records" }, line: "No records on 2–5 Nov 2026 · Draft v1 · 14:22 WIB" });
    expect(simView(v, { ...run, status: "running" as const }, run, false)).toMatchObject({ chip: { label: "Running" }, dim: true, counts: run });
    expect(simView(v, run, run, true)).toMatchObject({ chip: { label: "Out of date" }, line: "The draft changed after the last simulation", dim: true });
    expect(simView({ ...v, matchingHash: "h2" }, run, run, false).chip.label).toBe("Out of date");
    const failed = simView(v, { ...run, status: "failed" as const, error: "The run stopped before it finished. Run it again." }, null, false);
    // a run that failed is red and says Failed: Stopped is the grey of something turned off on purpose (review 24 Nov)
    expect(failed).toMatchObject({ chip: { health: "down", label: "Failed" }, line: "The simulation stopped: the run stopped before it finished. Run it again.", counts: null });
  });

  it("reads a group's difference from its evidence (side B − side A) in the currency's units", () => {
    const amount = { predicates: [{ op: "eq", field: "ext_ref", passed: true, delta: null }, { op: "amount_abs_tol", field: "amount_minor", passed: true, delta: 50000 }] };
    expect(differenceText(amount, "IDR")).toBe("Amount +500.00");
    expect(differenceText({ predicates: [{ op: "date_window", field: "business_date", passed: true, delta: 1 }] }, "IDR")).toBe("Date +1 day");
    expect(differenceText({ predicates: [{ op: "date_window", field: "business_date", passed: true, delta: 0 }] }, "IDR")).toBe("");
    expect(differenceText(null, "IDR")).toBe("");
    expect(amountText("2551779", "IDR")).toBe("25,517.79");
    expect(amountText("-500", "JPY")).toBe("-500");
    expect(amountText(null, "IDR")).toBe("—");
  });

  it("says what day close would do with the gate's waiting items, and sums a strip day", () => {
    const none = { a: 0, b: 0 };
    const gateProjection = { a: { "No counterpart": 20, "Currency differs": 3, "Amount differs": 1 }, b: { "No counterpart": 20, "Currency differs": 3, "Amount differs": 1 }, unconfirmed: none };
    const L = ["source1", "source2"] as const;
    expect(projectionText(gateProjection, L)).toBe("3 currency differs · 1 amount outside tolerance · 20 no counterpart");
    expect(projectionText({ ...gateProjection, unconfirmed: { a: 24, b: 24 } }, L)).toBe("3 currency differs · 1 amount outside tolerance · 20 no counterpart · 24 unconfirmed suggestions");
    expect(projectionText({ ...gateProjection, unconfirmed: { a: 24, b: 24 } }, L, ["Currency differs"])).toBe("1 amount outside tolerance · 20 no counterpart · 24 unconfirmed suggestions");
    expect(projectionText({ a: { "No counterpart": 2 }, b: { "No counterpart": 1 }, unconfirmed: none }, L)).toBe("2 source1 · 1 source2 no counterpart");
    // a one-way recon: side B without a counterpart is not required (DEC-055)
    expect(projectionText({ a: { "No counterpart": 2 }, b: { "Not required": 5 }, unconfirmed: none }, L)).toBe("2 source1 · 0 source2 no counterpart · 0 source1 · 5 source2 not required");
    // a reason the web has no words for is never printed raw
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(projectionText({ a: { "Something new": 5 }, b: {}, unconfirmed: none }, L)).toBe("");
    expect(projectionText({ a: { "Something new": 5 }, b: {}, unconfirmed: none }, L)).toBe("");
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    expect(reasonCount(gateProjection, "Currency differs", ["source1", "source2"])).toBe("3 pairs");
    expect(reasonCount(gateProjection, "Date differs", ["source1", "source2"])).toBeNull();
    // 2 Nov of the answer key: 312 matched, 5 suggested, 7 · 8 waiting, 12 duplicate items
    const day = { passes: { 1: { matched: 312, suggested: 0, broken: 12, brokenRefs: 4 }, 2: { matched: 0, suggested: 3, broken: 0, brokenRefs: 0 }, 3: { matched: 0, suggested: 2, broken: 0, brokenRefs: 0 } }, open: { a: 7, b: 8 } };
    expect(dayTotals(day, spec)).toEqual({ matched: 312, suggested: 5, duplicate: 12, ambiguous: 0, waiting: { a: 7, b: 8 }, breaks: null, closed: false });
  });

  it("reads the gate after its days closed as it stands now: 937 matched, 0 suggested, 30 duplicate, 48 · 48 breaks, 0 · 0 waiting", () => {
    // the gate run's days after day close (answer key per date; suggestions and waiting items broke at close)
    const day = (date: string, matched: number, dup: number, breaksA: number, breaksB: number) => ({
      date, closed: true, open: { a: 0, b: 0 }, breaks: { a: breaksA, b: breaksB },
      passes: { 1: { matched, suggested: 0, broken: dup, brokenRefs: 0 }, 2: { matched: 0, suggested: 0, broken: 0, brokenRefs: 0 }, 3: { matched: 0, suggested: 0, broken: 0, brokenRefs: 0 } },
    });
    const days = [day("2026-11-02", 312, 12, 12, 13), day("2026-11-03", 313, 9, 16, 16), day("2026-11-04", 312, 9, 16, 15), day("2026-11-05", 0, 0, 4, 4)];
    const live = { matched: 937, suggested: 0, breaks: { a: 48, b: 48 }, open: { a: 0, b: 0 } };
    const run = { counters: gate, days, live, from: "2026-11-02", to: "2026-11-05" };
    const t = standingTotals(run, spec);
    expect(t).toMatchObject({ matched: 937, suggested: 0, duplicate: 30, waiting: { a: 0, b: 0 }, breaks: { a: 48, b: 48 }, items: 2000 });
    expect(countLine(t, ["source1", "source2"])).toBe("937 matched · 0 suggested (open) · 30 duplicate · 0 waiting per side · 48 unmatch per side · match rate 93.7%");
    expect(dayPasses(days)["1"]).toMatchObject({ matched: 937, broken: 30 });
    expect(dayTotals(days[0]!, spec)).toMatchObject({ breaks: { a: 12, b: 13 }, closed: true });
    // a carry-over date before the run (1 Nov) is a tile of its own and never counts in the totals or the pass tabs
    const withCarry = { ...run, days: [day("2026-11-01", 5, 4, 1, 1), ...days] };
    expect(runDays(withCarry).map((d) => d.date)).toEqual(["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"]);
    expect(standingTotals(withCarry, spec)).toMatchObject({ matched: 937, duplicate: 30 });
    expect(dayPasses(runDays(withCarry))["1"]).toMatchObject({ matched: 937, broken: 30 });
    // without days or live (a run before them, or days that couldn't be read): what the run itself did
    expect(standingTotals({ counters: gate, days: null, live: null, from: "2026-11-02", to: "2026-11-05" }, spec)).toMatchObject({ matched: 937, suggested: 24, waiting: { a: 24, b: 24 }, breaks: null });
    expect(standingTotals({ counters: gate, days: [], live: null, from: "2026-11-02", to: "2026-11-05" }, spec).suggested).toBe(24);
    // a run with no new records still shows its dates' match rate when the API counts the records there (live.items)
    const quiet = { ...gate, intake: { a: 0, b: 0 } };
    expect(standingTotals({ ...run, counters: quiet }, spec).rate).toBeNull();
    expect(standingTotals({ ...run, counters: quiet, live: { ...live, items: { a: 1000, b: 1000 } } }, spec).rate).toBeCloseTo(0.937);
    const n1Spec = { ...spec, passes: [{ ...spec.passes[0]!, cardinality: "N:1" }, ...spec.passes.slice(1)] } as ReconSpec;
    expect(standingTotals({ ...run, live: { ...live, items: { a: 2000, b: 1000 } } }, n1Spec).rate).toBe(runTotals(gate, n1Spec).rate);
    expect(itemsText(0)).toBe("no new records");
    expect(itemsText(2000)).toBe("2,000 items");
  });

  it("names the sides in a per-side count, one number when both agree (R4-1)", () => {
    const L = ["src1 r2", "src2 r2b"] as const;
    expect(sidesText({ a: 48, b: 48 }, L, "unmatch")).toBe("48 unmatch per side");
    expect(sidesText({ a: 7, b: 8 }, L, "waiting")).toBe("7 src1 r2 · 8 src2 r2b waiting");
  });

  it("counts the Breaks tab per side: breaks of time and the items passes broke; no tab for a simulation", () => {
    const side = (n: number) => ({ a: n, b: n });
    const counters = { ...gate, passes: { ...gate.passes, 1: { matched: 937, suggested: 0, broken: 30, brokenItems: side(15), matchedItems: side(937), suggestedItems: side(0) } } };
    const live = { matched: 937, suggested: 0, breaks: side(48), open: side(0) };
    expect(breakCounts({ mode: "manual", counters, live })).toEqual({ a: 63, b: 63 });
    expect(breakCounts({ mode: "simulation", counters, live })).toBeNull();
    expect(breakCounts({ mode: "manual", counters, live: null })).toBeNull();
  });

  it("says where a lone break could have found its counterpart: its date and up to carry over before it", () => {
    expect(counterpartWindow("2026-11-03", 1)).toBe("2–3 Nov 2026");
    expect(counterpartWindow("2026-11-03", 0)).toBe("3 Nov 2026");
    expect(carryOverText("2026-11-04", 1)).toBe("Carry over is 1 day, so a 4 Nov item is looked for on 3 and 4 Nov.");
    expect(carryOverText("2026-11-04", 0)).toBe("Carry over is 0 days, so a 4 Nov item is looked for on 4 Nov.");
    expect(carryOverText("2026-11-04", 2)).toBe("Carry over is 2 days, so a 4 Nov item is looked for on 2–4 Nov.");
    // always (owner, 22 Nov): an unmatch is looked for on every run, whatever its age
    expect(carryOverText("2026-11-04", null)).toBe("Carry over is always, so a 4 Nov item is looked for on every run until it matches or is closed.");
    expect(counterpartWindow("2026-11-04", null)).toBe("4 Nov 2026 or later");
    expect(carryOverText("2026-12-01", 1)).toBe("Carry over is 1 day, so a 1 Dec item is looked for on 30 Nov and 1 Dec.");
  });

  it("Breaks on the gate run: the tab counts what the list holds (63 · 63) and each reason has its chip", () => {
    const byReason = { Duplicate: { a: 15, b: 15 }, "Date differs": { a: 10, b: 10 }, "Amount differs": { a: 15, b: 15 }, "No counterpart": { a: 20, b: 20 }, "Currency differs": { a: 3, b: 3 } };
    const live = { matched: 937, suggested: 0, breaks: { a: 48, b: 48 }, open: { a: 0, b: 0 }, items: { a: 1000, b: 1000 }, breakReasons: byReason };
    expect(breakCounts({ mode: "manual", counters: gate, live })).toEqual({ a: 63, b: 63 });
    expect(reasonOptions(byReason).map((o) => `${o.label} ${o.count}`).join(" · "))
      .toBe("All 126 · Duplicate 30 · Currency differs 6 · Amount differs 30 · Date differs 20 · No counterpart 40");
    expect(reasonOptions({ "No counterpart": { a: 1, b: 0 }, Duplicate: { a: 0, b: 0 } }).map((o) => o.label)).toEqual(["All", "No counterpart"]);
  });

  it("a proposed pair's difference from its two records (B − A); another currency is the difference", () => {
    const a = { amountMinor: "2551779", currency: "IDR", businessDate: "2026-11-04" };
    expect(pairDifference(a, { ...a, amountMinor: "2601779" })).toBe("Amount +500.00");
    expect(pairDifference(a, { ...a, businessDate: "2026-11-05" })).toBe("Date +1 day");
    expect(pairDifference(a, { ...a, currency: "USD" })).toBe("IDR vs USD");
    expect(pairDifference(a, a)).toBe("");
  });

  it("says what the other side held for a break without a pair to show, by its reason", () => {
    const item = { extRef: "TSTREF000983", businessDate: "2026-11-04", breakReason: "No counterpart", breakPass: null };
    expect(lonePairText(item, 1)).toBe("No item with reference TSTREF000983 on 3–4 Nov 2026.");
    expect(lonePairText({ ...item, extRef: "TSTREF000966", breakReason: "Duplicate", breakPass: 1 }, 1)).toBe("Reference TSTREF000966 is on more than one item of a side, so pass 1 paired none of them.");
    expect(lonePairText({ ...item, breakReason: "Currency differs" }, 1)).toBe("An item with reference TSTREF000983 on 3–4 Nov 2026 is in another currency.");
  });

  it("one source for a break's pair: its proposal, else the other side of the suggestion it still holds (re-check 5, B2)", () => {
    const member = (side: "a" | "b", extRef: string, businessDate: string) => ({ side, recordId: side, extRef, amountMinor: "2678483", currency: "IDR", businessDate });
    const group = { id: "g", passNo: 3, kind: "suggested" as const, businessDate: "2026-11-03", evidence: {}, memberCount: 2, members: [member("a", "TSTREF000957", "2026-11-02"), member("b", "TSTREF000957", "2026-11-03")] };
    expect(breakPair({ side: "a", proposed: null, group })).toEqual({ side: "b", extRef: "TSTREF000957", passNo: 3, amountMinor: "2678483", currency: "IDR", businessDate: "2026-11-03" });
    const proposed = { itemId: "i", side: "b" as const, passNo: 2, extRef: "TSTREF000942", amountMinor: "2609698", currency: "IDR", businessDate: "2026-11-02" };
    expect(breakPair({ side: "a", proposed, group })?.passNo).toBe(2);
    expect(breakPair({ side: "a", proposed: null, group: null })).toBeNull();
  });

  it("one line for a real run's breaks, Duplicate included (Captain): gate after close", () => {
    const L = ["src1 r2", "src2 r2b"] as const;
    const byReason = { Duplicate: { a: 15, b: 15 }, "Date differs": { a: 10, b: 10 }, "Amount differs": { a: 15, b: 15 }, "No counterpart": { a: 20, b: 20 }, "Currency differs": { a: 3, b: 3 } };
    const live = { matched: 937, suggested: 0, breaks: { a: 48, b: 48 }, open: { a: 0, b: 0 }, items: { a: 1000, b: 1000 }, breakReasons: byReason };
    const run = { mode: "manual" as const, counters: gate, days: [], live, from: "2026-11-02", to: "2026-11-05" };
    expect(runLine(run, spec, L)).toBe("937 matched · 63 unmatch per side (15 duplicate per side) · match rate 93.7%");
    expect(breaksText({ breaks: { a: 63, b: 62 }, duplicate: { a: 15, b: 14 } }, L)).toBe("63 src1 r2 · 62 src2 r2b unmatch (15 src1 r2 · 14 src2 r2b duplicate)");
    expect(breaksText({ breaks: { a: 48, b: 48 }, duplicate: { a: 0, b: 0 } }, L)).toBe("48 unmatch per side");
    expect(breaksText(breaksOf(byReason)!, L, false)).toBe("63 per side (15 duplicate per side)");
    // a simulation keeps its own counts: duplicates by their pass, never relabeled as breaks
    expect(runLine({ ...run, mode: "simulation" as const }, spec, L)).toBe(countLine(standingTotals(run, spec), L));
    // a run before live totals: its own counts
    expect(runLine({ ...run, live: null }, spec, L)).toBe("937 matched · 24 suggested (open) · 30 duplicate · 24 waiting per side · match rate 93.7%");
  });
});

describe("the replay a simulation starts with (owner, 22 Nov: never a date without data)", () => {
  const row = (last: string, recent: number[]) => ({ recent, health: { businessDate: last } });
  it("reads a source's record dates from its 7-date trend", () => {
    expect(recordDates(row("2026-11-22", [0, 0, 0, 0, 0, 3, 5]))).toEqual(["2026-11-21", "2026-11-22"]);
    expect(recordDates({ recent: [], health: null })).toEqual([]);
  });
  it("the latest closed date both sides have, else today, else what one side has", () => {
    expect(suggestedReplay(["2026-11-20", "2026-11-21", "2026-11-22"], ["2026-11-21", "2026-11-22"], "2026-11-22")).toEqual({ from: "2026-11-21", to: "2026-11-21" });
    expect(suggestedReplay(["2026-11-22"], ["2026-11-22", "2026-11-23"], "2026-11-22")).toEqual({ from: "2026-11-22", to: "2026-11-22" });
    expect(suggestedReplay(["2026-11-20"], [], "2026-11-22")).toEqual({ from: "2026-11-20", to: "2026-11-20" });
    expect(suggestedReplay([], [], "2026-11-22")).toBeNull();
    expect(suggestedReplay(null, ["2026-11-22"], "2026-11-22")).toBeNull();
  });
  it("says which side has nothing on the dates picked and where records are", () => {
    const sides = [{ label: "Core banking", dates: ["2026-11-22"] }, { label: "BI-FAST switch", dates: ["2026-11-22", "2026-11-23"] }];
    expect(replayGap({ from: "2026-11-21", to: "2026-11-21" }, sides)).toMatch(/^Core banking and BI-FAST switch have no records on .+\. Records are on .+\.$/);
    expect(replayGap({ from: "2026-11-22", to: "2026-11-22" }, sides)).toBeNull();
  });
});


describe("a run history row's chips (review: Simulated + Simulation on one row)", () => {
  it("the state chip, then its kind, unless the state already says it (a finished simulation)", () => {
    expect(runRowChips({ status: "succeeded", mode: "simulation" })).toEqual({ chip: { health: "healthy", label: "Simulated" }, mode: null });
    expect(runRowChips({ status: "running", mode: "simulation" })).toEqual({ chip: { health: "progress", label: "Running" }, mode: "Simulation" });
    expect(runRowChips({ status: "failed", mode: "simulation" }).mode).toBe("Simulation");
    expect(runRowChips({ status: "succeeded", mode: "daily" })).toEqual({ chip: { health: "healthy", label: "Done" }, mode: "Scheduled" });
    expect(runRowChips({ status: "queued", mode: "rerun" })).toEqual({ chip: { health: "progress", label: "Queued" }, mode: "Rerun" });
  });
});

describe("the results table's caption names its scope (audit R8)", () => {
  it("what the tab shows, how many, and of how many records read on its dates", () => {
    expect(scopeCaption("Pass 1", 32, "matched pairs", 18571)).toBe("Pass 1 · 32 matched pairs of 18,571 read");
    expect(scopeCaption("Waiting", 2, "items", null)).toBe("Waiting · 2 items");
  });
  it("records read: both sides of each date, or unknown when a date doesn't say", () => {
    expect(readIn([{ items: { a: 10, b: 5 } }, { items: { a: 1, b: 0 } }])).toBe(16);
    expect(readIn([{ items: { a: 10, b: 5 } }, {}])).toBeNull();
    expect(readIn([])).toBeNull();
  });
});

describe("the run's currency (§5.9: in the amount headers when every row has it, the same on every page)", () => {
  it("both sides' sources write one fixed currency: that one; a currency column, none or two: null (a Currency column)", () => {
    const fixed = (currency?: string, column = false) => ({ currency, mapping: column ? { currency: { field: "ccy" } } : {} });
    expect(runCurrency(fixed("IDR"), fixed("IDR"))).toBe("IDR");
    expect(runCurrency(fixed("IDR"), fixed("USD"))).toBeNull();
    expect(runCurrency(fixed("IDR"), fixed(undefined, true))).toBeNull();
    expect(runCurrency(fixed(), fixed())).toBeNull();
    expect(runCurrency(null, fixed("IDR"))).toBeNull();
  });
});
