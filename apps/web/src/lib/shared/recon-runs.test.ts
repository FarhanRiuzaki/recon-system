import { describe, expect, it } from "vitest";
import { pickLastRuns } from "./recon-runs";

const row = (id: string, mode: string, startedAt: string) => ({ id, mode, startedAt });
const gate = row("gate", "manual", "2026-11-21T01:00:00Z");

describe("pickLastRuns: a recon's Overview headline (R6-1)", () => {
  it("the newest run with records; a newer real run without records is the small line, never the headline", () => {
    const latest = [row("sim", "simulation", "2026-11-21T09:00:00Z"), row("empty", "daily", "2026-11-21T08:55:00Z"), gate];
    expect(pickLastRuns([gate], latest)).toEqual({ headline: gate, newer: latest[1] });
  });
  it("the newest run is the one with records: no small line", () => {
    expect(pickLastRuns([gate], [gate])).toEqual({ headline: gate, newer: null });
  });
  it("no run took in records yet: the last real run, as before; no runs: nothing", () => {
    const empty = row("empty", "daily", "2026-11-21T08:55:00Z");
    expect(pickLastRuns([], [row("sim", "simulation", "2026-11-21T09:00:00Z"), empty])).toEqual({ headline: empty, newer: null });
    expect(pickLastRuns([], [])).toEqual({ headline: null, newer: null });
  });
});
