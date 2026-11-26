import { EDIT_DRAFT_REASON, sampleLine } from "./report-text";
import { FILE_LEGEND } from "./report-columns";
import { describe, expect, it } from "vitest";
import { datesText, dayText, finalText, generateProblem, openDatesNotice, refLabel, statusText } from "./report-text";

describe("labels and dates on screen (owner 26 Nov: no raw field names, the app's date format)", () => {
  const fields = new Map([["a:ext_ref", { label: "Reference" }]]);
  it("a field ref as its label, else its name in words; never the ref itself", () => {
    expect(refLabel("a:ext_ref", fields)).toBe("Reference");
    expect(refLabel("b:attrs.creditor_bank", fields)).toBe("Creditor bank");
    expect(refLabel("recon:businessDate", fields)).toBe("Business date");
    expect(refLabel("item:response_code", fields)).toBe("Response code");
    expect(refLabel("", fields)).toBe("A field");
  });
  it("a calendar date and a range in the app's format", () => {
    expect(dayText("2026-11-25")).toBe("25 Nov 2026");
    expect(datesText("2026-11-25", "2026-11-25")).toBe("25 Nov 2026");
    expect(datesText("2026-11-01", "2026-11-25")).toBe("1 Nov 2026 – 25 Nov 2026");
    expect(dayText("")).toBe("–");
  });
});

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

describe("the Test's sample line", () => {
  it("says it's being made until ready, then offers it; a failed one says why", () => {
    expect(sampleLine(undefined)).toEqual({ link: false, text: "Making the sample file…" });
    expect(sampleLine({ status: "making", error: null })).toEqual({ link: false, text: "Making the sample file…" });
    expect(sampleLine({ status: "ready", error: null })).toEqual({ link: true, text: "Download sample file" });
    expect(sampleLine({ status: "failed", error: "A PDF holds at most 5,000 rows." })).toEqual({ link: false, text: "The sample file failed: A PDF holds at most 5,000 rows." });
  });
  it("the Edit draft and progress copy say what they mean", () => {
    expect(EDIT_DRAFT_REASON).toBe("Only a config maker of this space edits a report template's draft.");
    expect(JSON.stringify(FILE_LEGEND)).toContain("Being made; the bar shows how far it is.");
  });
});
