import { describe, expect, it } from "vitest";
import { hexToRgb, LEDGER, planLedgers, seeded } from "./ledger-plan";

const plan = planLedgers(LEDGER.seed);

describe("ledger plan (sign-in backdrop)", () => {
  it("is the same for one seed and differs for another", () => {
    expect(planLedgers(LEDGER.seed)).toEqual(plan);
    expect(planLedgers(LEDGER.seed + 1)).not.toEqual(plan);
    const a = seeded(7), b = seeded(7);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });

  it("every pair is one record from each side, meeting at one moment in mirrored lattice slots", () => {
    for (const p of plan.pairs) {
      const a = plan.records[p.a]!, b = plan.records[p.b]!;
      expect([a.side, b.side]).toEqual([-1, 1]);
      expect(a.tMatch).toBe(p.tMatch);
      expect(b.tMatch).toBe(p.tMatch);
      expect(a.slot[0]).toBeCloseTo(-b.slot[0]);
      expect(a.slot[1]).toBe(b.slot[1]);
      expect(a.slot[0]).toBeLessThan(0);
    }
    const slots = plan.pairs.map((p) => plan.records[p.a]!.slot.join());
    expect(new Set(slots).size).toBe(slots.length);
  });

  it("the lattice grows from the middle outward in the order pairs match", () => {
    const rings = [...plan.pairs].sort((x, y) => x.tMatch - y.tMatch).map((p) => p.ring);
    expect(rings).toEqual([...rings].sort((x, y) => x - y));
    expect(rings[0]).toBe(0);
  });

  it("most records match on arrival, before the pass", () => {
    for (const r of plan.records.filter((x) => !x.waits)) expect(r.tArrive).toBe(r.tMatch);
    const beforePass = plan.records.filter((r) => !r.waits && r.tMatch < LEDGER.passAt);
    expect(beforePass).toHaveLength(LEDGER.pairs * 2);
    expect(beforePass.length).toBeGreaterThan(plan.records.length * 0.7);
  });

  it("a few records wait with no counterpart; the pass pairs most of them, the rest keep waiting", () => {
    const waiting = plan.records.filter((r) => r.waits);
    expect(waiting).toHaveLength(LEDGER.orphans);
    for (const r of waiting) expect(r.tArrive).toBeLessThan(LEDGER.passAt);
    const paired = waiting.filter((r) => Number.isFinite(r.tMatch));
    expect(paired).toHaveLength(LEDGER.orphans - LEDGER.unresolved);
    for (const r of paired) expect(r.tMatch).toBeGreaterThanOrEqual(LEDGER.passAt);
    // A paired waiter's counterpart arrives with the pass, exactly when they meet.
    for (const r of paired) {
      const pair = plan.pairs.find((p) => plan.records[p.a] === r || plan.records[p.b] === r)!;
      const other = plan.records[plan.records[pair.a] === r ? pair.b : pair.a]!;
      expect(other.waits).toBe(false);
      expect(other.tArrive).toBe(other.tMatch);
    }
    // Unresolved waiters belong to no pair.
    const inPairs = new Set(plan.pairs.flatMap((p) => [p.a, p.b]));
    expect(plan.records.filter((r, i) => !inPairs.has(i))).toHaveLength(LEDGER.unresolved);
  });

  it("everything starts after 0 and settles before the cycle's fade", () => {
    for (const r of plan.records) {
      expect(r.tStart).toBeGreaterThanOrEqual(0);
      expect(r.tArrive).toBeGreaterThan(r.tStart);
      if (Number.isFinite(r.tMatch)) expect(r.tMatch + LEDGER.settle).toBeLessThan(LEDGER.cycle - LEDGER.fade);
    }
    expect(plan.pairs.length).toBeLessThanOrEqual(LEDGER.rows * LEDGER.rings);
  });
});

describe("hexToRgb", () => {
  it("reads #rrggbb and #rgb, trimmed and in any case, as 0–1 channels", () => {
    expect(hexToRgb("#ff0000")).toEqual([1, 0, 0]);
    expect(hexToRgb(" #FFA928 ")).toEqual([1, 0xa9 / 255, 0x28 / 255]);
    expect(hexToRgb("#fff")).toEqual([1, 1, 1]);
  });
  it("answers null for anything else, so a missing token keeps the last colour", () => {
    for (const v of ["", "ffa928", "#ffa92", "rgb(1, 2, 3)", "var(--x)", "#ggg"]) expect(hexToRgb(v)).toBeNull();
  });
});
