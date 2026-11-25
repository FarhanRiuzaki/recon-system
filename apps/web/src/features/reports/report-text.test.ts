import { describe, expect, it } from "vitest";
import { finalText, generateProblem, openDatesNotice, statusText } from "./report-text";

describe("report text", () => {
  it("names a file's state and whether it is final", () => {
    expect(statusText({ status: "making", progress: 62 })).toBe("Making… 62%");
    expect(statusText({ status: "queued", progress: 0 })).toBe("Queued");
    expect(statusText({ status: "ready", progress: 100 })).toBe("Ready");
    expect(statusText({ status: "failed", progress: 10 })).toBe("Failed");
    expect(statusText({ status: "removed", progress: 100 })).toBe("Removed");
    expect([finalText(true), finalText(false)]).toEqual(["Final", "Not final"]);
  });

  it("says when the range is too long or reversed, and how many of its dates aren't signed off", () => {
    expect(generateProblem("2026-08-01", "2026-11-01")).toBe("A report covers at most 92 days. Pick a shorter range.");
    expect(generateProblem("2026-11-05", "2026-11-01")).toBe("The end date is before the start date.");
    expect(generateProblem("2026-11-01", "2026-11-24")).toBeNull();
    expect(openDatesNotice(3)).toBe("3 of these dates aren't signed off yet: the report is marked Not final.");
    expect(openDatesNotice(1)).toBe("1 of these dates isn't signed off yet: the report is marked Not final.");
    expect(openDatesNotice(0)).toBeNull();
  });
});
