import { describe, expect, it } from "vitest";
import { sourceStatus } from "./source-status";

const health = (state: "healthy" | "degraded" | "down") => ({ state, businessDate: "2026-11-19", lagSeconds: null, completeThrough: null, reason: null, missingDate: null, lastError: null });

describe("sourceStatus", () => {
  it("shows the API's health; paused is stopped whatever the health says; no published version is Draft", () => {
    expect(sourceStatus({ status: "active", publishedVersion: 1, health: health("degraded") })).toEqual({ health: "degraded", label: "Degraded" });
    expect(sourceStatus({ status: "active", publishedVersion: 1, health: health("healthy") })).toEqual({ health: "healthy", label: "Healthy" });
    expect(sourceStatus({ status: "paused", publishedVersion: 1, health: health("down") })).toEqual({ health: "stopped", label: "Paused" });
    expect(sourceStatus({ status: "active", publishedVersion: null, health: null })).toEqual({ health: "stopped", label: "Draft" });
    expect(sourceStatus({ status: "active", publishedVersion: 1, health: null })).toEqual({ health: "unknown", label: "Unknown" });
  });
});
