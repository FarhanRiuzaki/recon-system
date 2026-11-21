import { describe, expect, it } from "vitest";
import { pickLastRuns } from "./recon-runs";

const row = (id: string, mode: string, records: number) => ({ id, mode, counters: { intake: { a: records, b: records } } });

describe("pickLastRuns: a recon's Overview headline (R6-1)", () => {
  it("the newest real run that took in records; a newer empty run is the small line, never the headline", () => {
    const rows = [row("sim", "simulation", 5), row("empty", "daily", 0), row("gate", "manual", 1000), row("older", "manual", 10)];
    const { headline, newer } = pickLastRuns(rows);
    expect(headline?.id).toBe("gate");
    expect(newer?.id).toBe("empty");
  });
  it("the newest run is the one with records: no small line", () => {
    expect(pickLastRuns([row("gate", "manual", 1000), row("empty", "daily", 0)])).toMatchObject({ headline: { id: "gate" }, newer: null });
  });
  it("no run took in records yet: the last run, as before; no runs: nothing", () => {
    expect(pickLastRuns([row("e2", "daily", 0), row("e1", "daily", 0)])).toMatchObject({ headline: { id: "e2" }, newer: null });
    expect(pickLastRuns([row("sim", "simulation", 5)])).toEqual({ headline: null, newer: null });
  });
});
