import { describe, expect, it } from "vitest";
import { reconStatus } from "./recon-status";

describe("reconStatus: one chip for a recon on every screen", () => {
  it("no published version: Draft, or In review while its draft waits for a checker", () => {
    expect(reconStatus({ status: "active", publishedVersion: null }).label).toBe("Draft");
    expect(reconStatus({ status: "active", publishedVersion: null, draft: { status: "draft" } }).label).toBe("Draft");
    expect(reconStatus({ status: "active", publishedVersion: null, draft: { status: "in_review" } }).label).toBe("In review");
  });
  it("a published version: Live, or Paused; a newer draft in review doesn't change it", () => {
    expect(reconStatus({ status: "active", publishedVersion: 1, draft: { status: "in_review" } }).label).toBe("Live");
    expect(reconStatus({ status: "paused", publishedVersion: 1 }).label).toBe("Paused");
  });
  it("a list row reads its draftStatus the same way (In review in the list too)", () => {
    expect(reconStatus({ status: "active", publishedVersion: null, draftStatus: "in_review" }).label).toBe("In review");
    expect(reconStatus({ status: "active", publishedVersion: null, draftStatus: "draft" }).label).toBe("Draft");
    expect(reconStatus({ status: "active", publishedVersion: null, draftStatus: null }).label).toBe("Draft");
  });
});
