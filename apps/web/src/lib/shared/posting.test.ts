import { describe, expect, it } from "vitest";
import { attentionText, POSTING_FILTER, postingChip, postingEvent } from "./posting";

describe("posting statuses as people read them", () => {
  it("names each status with one of the five health states", () => {
    expect(postingChip("posted")).toEqual({ health: "healthy", label: "Posted" });
    expect(postingChip("failed")).toEqual({ health: "down", label: "Failed" });
    expect(postingChip("not_sent")).toEqual({ health: "down", label: "Not sent" });
    expect(postingChip("timeout")).toEqual({ health: "degraded", label: "Timeout" });
    expect(postingChip("no_rule")).toEqual({ health: "stopped", label: "No posting rule" });
    expect(postingChip("skipped")).toEqual({ health: "stopped", label: "Skipped" });
    expect(postingChip("queued")).toEqual({ health: "unknown", label: "Waiting to send" });
    expect(postingChip("sending")).toEqual({ health: "unknown", label: "Sending" });
  });
  it("reads the event that fired an action", () => {
    expect(postingEvent({ event: "level_approved", level: 2 })).toBe("Level 2 approved");
    expect(postingEvent({ event: "approved", level: null })).toBe("Approved");
    expect(postingEvent({ event: "rejected", level: null })).toBe("Rejected");
  });
  it("offers the statuses that need someone's attention first in the filter", () => {
    expect(POSTING_FILTER.map((o) => o.value).slice(0, 3)).toEqual(["failed", "timeout", "not_sent"]);
  });
  it("sums up a recon's runs that need someone, the non-zero ones only", () => {
    expect(attentionText({ failed: 2, timeout: 1, notSent: 0 })).toBe("2 failed, 1 timeout");
    expect(attentionText({ failed: 0, timeout: 0, notSent: 3 })).toBe("3 not sent");
  });
});
