import { describe, expect, it } from "vitest";
import { AGE_BUCKETS } from "./recon";
import { RESULT_STATUSES } from "./results";
import { AGE_GROUPS, CLOSED_PARTS, median, POSTING_FAILED, RESOLVED_STATUSES } from "./dashboard";

describe("dashboard vocabulary", () => {
  it("the age groups cover every Unmatch age bucket exactly once, in order", () => {
    expect(AGE_GROUPS.flatMap((g) => g.buckets)).toEqual([...AGE_BUCKETS]);
  });
  it("resolved and closed parts are Operation result statuses, closed parts each once", () => {
    for (const s of RESOLVED_STATUSES) expect(RESULT_STATUSES).toContain(s);
    const parts = CLOSED_PARTS.flatMap((p) => p.statuses);
    expect(new Set(parts).size).toBe(parts.length);
    for (const s of parts) expect(RESULT_STATUSES).toContain(s);
    expect(POSTING_FAILED).toEqual(["failed", "timeout", "not_sent"]);
  });
  it("median: middle value, mean of the two middle ones, null for none", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([9, 1, 5])).toBe(5);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});
