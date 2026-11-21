import { describe, expect, it } from "vitest";
import { reconStatus } from "./recon-status";

describe("reconStatus: one chip for a recon, in the list and on its page", () => {
  it("no published version: Draft, or In review while its open version waits for a checker", () => {
    expect(reconStatus({ status: "active", publishedVersion: null, draftStatus: null }).label).toBe("Draft");
    expect(reconStatus({ status: "active", publishedVersion: null, draftStatus: "draft" }).label).toBe("Draft");
    expect(reconStatus({ status: "active", publishedVersion: null, draftStatus: "in_review" }).label).toBe("In review");
  });
  it("a published version: Live, or Paused; a newer version in review doesn't change it", () => {
    expect(reconStatus({ status: "active", publishedVersion: 1, draftStatus: "in_review" }).label).toBe("Live");
    expect(reconStatus({ status: "paused", publishedVersion: 1, draftStatus: null }).label).toBe("Paused");
  });
});
