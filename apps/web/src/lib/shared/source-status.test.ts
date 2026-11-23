import { describe, expect, it } from "vitest";
import { PULL_STATUS, sourceStatus, versionChip, VERSION_STATUS } from "./source-status";

const health = (state: "healthy" | "degraded" | "down") => ({ state, businessDate: "2026-11-19", lagSeconds: null, completeThrough: null, reason: null, missingDate: null, lastError: null, lastReadAt: null });

describe("sourceStatus", () => {
  it("shows the API's health; paused is stopped whatever the health says; no published version is Draft", () => {
    expect(sourceStatus({ status: "active", publishedVersion: 1, health: health("degraded") })).toEqual({ health: "degraded", label: "Degraded" });
    expect(sourceStatus({ status: "active", publishedVersion: 1, health: health("healthy") })).toEqual({ health: "healthy", label: "Healthy" });
    expect(sourceStatus({ status: "paused", publishedVersion: 1, health: health("down") })).toEqual({ health: "stopped", label: "Paused" });
    expect(sourceStatus({ status: "active", publishedVersion: null, health: null })).toEqual({ health: "stopped", label: "Draft" });
    expect(sourceStatus({ status: "active", publishedVersion: 1, health: null })).toEqual({ health: "unknown", label: "Unknown" });
  });
});

describe("VERSION_STATUS", () => {
  it("draft grey, in review blue (waiting for a checker), published green, retired grey, each with its own word", () => {
    expect(Object.entries(VERSION_STATUS).map(([k, v]) => [k, v.health, v.label])).toEqual([
      ["draft", "stopped", "Draft"], ["in_review", "progress", "In review"], ["published", "healthy", "Published"], ["retired", "stopped", "Retired"],
    ]);
  });
  it("a sent-back draft needs its maker: amber", () => {
    expect(versionChip({ status: "draft", reviewComment: "fix the key" }).health).toBe("degraded");
  });
});

describe("versionChip", () => {
  it("a draft with a checker's comment is Sent back; any other version its status", () => {
    expect(versionChip({ status: "draft", reviewComment: "fix the key" }).label).toBe("Sent back");
    expect(versionChip({ status: "draft", reviewComment: null }).label).toBe("Draft");
    expect(versionChip({ status: "in_review", reviewComment: "old" }).label).toBe("In review");
  });
});

describe("PULL_STATUS (owner 24 Nov)", () => {
  it("New rows green, Nothing new grey, Failed red, Paused grey", () => {
    expect(Object.entries(PULL_STATUS).map(([k, v]) => [k, v.health, v.label])).toEqual([
      ["new", "healthy", "New rows"], ["nothing_new", "stopped", "Nothing new"], ["failed", "down", "Failed"], ["paused", "stopped", "Paused"],
    ]);
  });
});
