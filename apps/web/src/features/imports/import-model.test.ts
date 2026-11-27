import { describe, expect, it } from "vitest";
import { DATE_STATES, SCHEDULER_STATES } from "@starterkit/shared/imports";
import { DATE_LEGEND, dateChip, SCHEDULER_LEGEND, schedulerChip } from "./import-model";

describe("import status words", () => {
  it("every date and scheduler state has a chip and a legend line, in the states' order", () => {
    expect(DATE_LEGEND.map((l) => l.label)).toEqual(DATE_STATES.map((s) => dateChip(s).label));
    expect(SCHEDULER_LEGEND.map((l) => l.label)).toEqual(SCHEDULER_STATES.map((s) => schedulerChip(s).label));
    for (const l of [...DATE_LEGEND, ...SCHEDULER_LEGEND]) expect(l.description.endsWith(".")).toBe(true);
  });

  it("missing and failed dates and broken schedulers are red; late amber; off grey; imported green", () => {
    expect([dateChip("missing").health, dateChip("failed").health, dateChip("late").health, dateChip("imported").health]).toEqual(["down", "down", "degraded", "healthy"]);
    expect([schedulerChip("stuck").health, schedulerChip("missed").health, schedulerChip("off").health, schedulerChip("ok").health]).toEqual(["down", "down", "stopped", "healthy"]);
  });
});
