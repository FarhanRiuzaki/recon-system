import { describe, expect, it } from "vitest";
import type { LiveReconDto, LiveSourceDto, TodayDto } from "@starterkit/shared/contracts/recon";
import { countText, dayCounters, kpiCaption, dayTotals, nextRunText, reasonParts, reconChip, sourceLag, spaceMap, todayKpis } from "./live-model";

const health = (state: "healthy" | "degraded" | "down", o: Partial<NonNullable<LiveSourceDto["health"]>> = {}) =>
  ({ state, businessDate: "2026-11-21", lagSeconds: null, completeThrough: null, reason: null, missingDate: null, lastError: null, lastReadAt: null, ...o });
const src = (id: string, state: "healthy" | "degraded" | "down", rowsToday = 100): LiveSourceDto => ({ id, name: id.toUpperCase(), kind: "db_watermark", health: health(state), rowsToday });
const recon = (id: string, a: string, b: string, o: Partial<LiveReconDto> = {}): LiveReconDto => ({
  id, name: `Recon ${id}`, sides: [{ label: "A", sourceId: a }, { label: "B", sourceId: b }], schedule: { kind: "interval", every_minutes: 2 },
  date: "2026-11-21", state: "open", runId: "r1", runAt: null, lastSuccessAt: null, stale: false, alertedAt: null, running: null, openBreaks: 3,
  day: { date: "2026-11-21", passes: { 1: { matched: 937, suggested: 0, broken: 30, brokenRefs: 10 }, 2: { matched: 0, suggested: 14, broken: 0, brokenRefs: 0 } }, open: { a: 24, b: 20 }, breaks: { a: 1, b: 2 }, items: { a: 1000, b: 990 }, closed: false },
  ...o,
});

describe("Today and Live day model (REC-F4)", () => {
  it("a Degraded or Down source marks every recon that reads it; a stale recon is Stale before that", () => {
    const t: TodayDto = { capped: false, posting: [], sources: [src("s1", "healthy", 400), src("s2", "down", 100), src("s3", "healthy", 0)],
      recons: [recon("x", "s1", "s2"), recon("y", "s1", "s3"), recon("z", "s3", "s3", { stale: true })] };
    const g = spaceMap(t, (id) => `/r/${id}`);
    const node = (id: string) => g.nodes.find((n) => n.id === id)!;
    expect([node("rec-x").chip, node("rec-x").affectedBy]).toEqual([{ health: "down", label: "Source down" }, ["S2"]]);
    // an open day is under way: blue, not Healthy (owner 24 Nov)
    expect([node("rec-y").chip, node("rec-y").affectedBy]).toEqual([{ health: "progress", label: "Open" }, []]);
    expect(node("rec-z").chip).toEqual({ health: "degraded", label: "Stale" });
    // one edge per side (a recon reading one source twice draws it once), thicker for the busier source
    expect(g.edges.filter((e) => e.target === "rec-z").length).toBe(1);
    expect(g.edges.find((e) => e.id === "e-s1-x")!.width).toBe(4);
    expect(g.edges.find((e) => e.id === "e-s3-y")!.width).toBe(1);
    expect(node("rec-x").href).toBe("/r/x");
    // a recon whose run is under way: its edges flow; a queued one says so without flowing
    const run = spaceMap({ ...t, recons: [recon("x", "s1", "s2", { running: { id: "r", status: "running", startedAt: "" } }), recon("y", "s1", "s3", { running: { id: "q", status: "queued", startedAt: "" } })] }, (id) => id);
    expect(run.edges.map((e) => [e.id, e.live])).toEqual([["e-s1-x", true], ["e-s2-x", true], ["e-s1-y", false], ["e-s3-y", false]]);
    expect(run.nodes.find((n) => n.id === "rec-y")!.running).toBe("queued");
    // a source whose records just grew: its node says how many and its edges carry packets
    const inflow = spaceMap(t, (id) => id, new Map([["s3", 12]]));
    expect(inflow.nodes.find((n) => n.id === "src-s3")!.arriving).toBe(12);
    expect(inflow.edges.filter((e) => e.source === "src-s3").every((e) => e.live)).toBe(true);
    expect(inflow.edges.find((e) => e.id === "e-s1-x")!.live).toBe(false);
    // sources sit beside the first recon reading them, so the lanes' edges don't cross
    const s = spaceMap({ ...t, sources: [src("s3", "healthy"), src("s2", "healthy"), src("s1", "healthy")] }, (id) => id);
    expect(s.nodes.filter((n) => n.lane === 0).map((n) => n.id)).toEqual(["src-s1", "src-s2", "src-s3"]);
  });
  it("the day's totals and its counters for the pipeline; nothing before a run", () => {
    const r = recon("x", "s1", "s2");
    expect(dayTotals(r)).toEqual({ inItems: 1990, matched: 937, suggested: 14, waiting: 44, breaks: 33, rate: 0.937 });
    expect(dayCounters(r)!.intake).toEqual({ a: 1000, b: 990 });
    expect(dayTotals({ ...r, day: null })).toBeNull();
    expect(dayCounters({ ...r, day: null })).toBeUndefined();
  });
  it("a source's lag: a pull's minutes behind, else what it is complete through", () => {
    expect(sourceLag({ ...src("s", "healthy"), health: health("healthy", { lagSeconds: 1260 }) })).toBe("21 min behind");
    expect(sourceLag({ ...src("s", "healthy"), health: null })).toBe("Not ingesting yet");
    expect(reconChip({ ...recon("x", "s1", "s2"), state: "closed" }, new Map())).toEqual({ health: "healthy", label: "Closed" });
  });
});

describe("Today's KPI tray (audit T1)", () => {
  it("sums open unmatch and posting needing attention; counts degraded or down sources, not those without health", () => {
    const src = (state: "healthy" | "degraded" | "down" | null) => ({ health: state ? { state } : null }) as unknown as TodayDto["sources"][number];
    expect(todayKpis({
      recons: [{ openBreaks: 3 }, { openBreaks: 4 }] as unknown as TodayDto["recons"],
      sources: [src("healthy"), src("degraded"), src("down"), src(null)],
      posting: [{ reconId: "r", failed: 1, timeout: 2, notSent: 3, lateGroups: 1 }],
    })).toEqual({ unmatch: 7, posting: 6, behind: 2 });
  });

  it("a count the server stopped at reads N+ (Waiting for my approval past 500 requests)", () => {
    expect(countText(500, true)).toBe("500+");
    expect(countText(1234, false)).toBe("1,234");
    expect(countText(3)).toBe("3");
  });

  it("a tile whose read failed says so; one keeping its last value says it is not fresh", () => {
    const e = new Error("x");
    expect(kpiCaption({ data: undefined, error: e }, "the approvals")).toBe("Couldn't load the approvals");
    expect(kpiCaption({ data: 1, error: e }, "the approvals", "Every date")).toBe("Couldn't refresh the approvals; showing the last read");
    expect(kpiCaption({ data: 1, error: null }, "the approvals", "Every date")).toBe("Every date");
    expect(kpiCaption({ data: undefined, error: null }, "the approvals")).toBeUndefined();
  });
});

describe("the Run card's next run (audit R5)", () => {
  const at = (iso: string) => Date.parse(iso);
  it("an interval recon: its last scheduled start plus the interval, or now once that has passed", () => {
    const every2 = { kind: "interval" as const, every_minutes: 2 };
    // 23 Nov 00:02 WIB = 22 Nov 17:02 UTC
    expect(nextRunText(every2, "2026-11-22T17:02:00.000Z", at("2026-11-22T17:03:00.000Z"))).toBe("Next run due at 00:04 WIB");
    expect(nextRunText(every2, "2026-11-22T17:02:00.000Z", at("2026-11-22T17:05:00.000Z"))).toBe("Next run due now");
    expect(nextRunText(every2, null, at("2026-11-22T17:05:00.000Z"))).toBe("Next run due now");
  });
  it("a daily recon: today at its time while that is ahead, else tomorrow", () => {
    const daily = { kind: "daily" as const, at: "06:00", business_date_offset: 1 };
    expect(nextRunText(daily, null, at("2026-11-22T22:00:00.000Z"))).toBe("Next run at 06:00 WIB today"); // 05:00 WIB
    expect(nextRunText(daily, null, at("2026-11-23T00:00:00.000Z"))).toBe("Next run at 06:00 WIB tomorrow"); // 07:00 WIB
    expect(nextRunText(daily, null, at("2026-11-22T23:00:30.000Z"))).toBe("Next run due now"); // 06:00 WIB, its minute
  });
});

describe("unmatch by reason (audit R2): the queue's reason counts as breakdown parts that add up to the unmatch", () => {
  it("largest first, so each part takes its own series slot in order of size; items without a reason are a part of their own", () => {
    const facets = { state: { new: 30, assigned: 10 }, reason: { Duplicate: 2, "No counterpart": 30, "Amount differs": 4 } };
    const parts = reasonParts(facets);
    expect(parts).toEqual([{ label: "No counterpart", value: 30 }, { label: "Amount differs", value: 4 }, { label: "Duplicate", value: 2 }, { label: "No reason", value: 4 }]);
    expect(parts.reduce((n, p) => n + p.value, 0)).toBe(40);
    expect(parts.some((p) => "slot" in p)).toBe(false);
    expect(reasonParts({ state: { new: 3 }, reason: { Duplicate: 3 } })).toEqual([{ label: "Duplicate", value: 3 }]);
    expect(reasonParts(undefined)).toEqual([]);
  });
});
