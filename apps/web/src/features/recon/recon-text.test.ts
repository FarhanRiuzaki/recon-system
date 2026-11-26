import { describe, expect, it } from "vitest";
import { activitySentence, reviewReason } from "./recon-text";

const e = (action: string, after: unknown = null, before: unknown = null) => ({ action, actor: { name: "Dimas Arya" }, before, after });

describe("activitySentence", () => {
  it("one sentence per event, never a hash", () => {
    expect(activitySentence(e("recon.create", { code: "x", name: "X", version: 1, specHash: "abc" }))).toBe("Dimas Arya created the recon with Draft v1.");
    expect(activitySentence(e("day.sign", { date: "2026-11-21", stage: "signed" }))).toMatch(/^Dimas Arya signed off 21 Nov( 2026)?\.$/);
    expect(activitySentence(e("recon.version_update", { version: 2, specHash: "abc" }))).toBe("Dimas Arya saved Draft v2.");
    expect(activitySentence(e("recon.version_create", { version: 2, from: 1 }))).toBe("Dimas Arya started Draft v2 from version 1.");
    expect(activitySentence(e("recon.version_approve", { version: 2, specHash: "h", retired: 1 }))).toBe("Dimas Arya approved version 2; version 1 retired.");
    expect(activitySentence(e("recon.version_approve", { version: 3, specHash: "h", retired: 2, reopened: 4 })))
      .toBe("Dimas Arya approved version 3; version 2 retired; 4 side-B items not required are checked again.");
    expect(activitySentence(e("recon.version_reject", { version: 2, comment: "Add pass 3" }))).toBe("Dimas Arya sent version 2 back: “Add pass 3”");
    expect(activitySentence(e("recon.discard", null, { code: "x", name: "X" }))).toBe("Dimas Arya deleted the draft recon.");
    expect(activitySentence(e("recon.run", { runId: "r", version: 1, from: "2026-11-02", to: "2026-11-05" }))).toBe("Dimas Arya ran version 1 for 2–5 Nov 2026.");
    expect(activitySentence(e("recon.run_rollback", { runId: "r", startedAt: "2026-11-02T01:00:00.000Z", runs: 1, rerunId: "x", version: 3, from: "2026-11-02", to: "2026-11-02" })))
      .toBe("Dimas Arya rolled back a run; version 3 runs again for 2 Nov 2026.");
    expect(activitySentence(e("recon.run_rollback", { runId: "r", startedAt: "2026-11-02T01:00:00.000Z", runs: 4, rerunId: "x", version: 3, from: "2026-11-02", to: "2026-11-05" })))
      .toBe("Dimas Arya rolled back a run and the 3 after it; version 3 runs again for 2–5 Nov 2026.");
    expect(activitySentence(e("recon.simulate", { runId: "r", version: 2, specHash: "h", from: "2026-11-02", to: "2026-11-02" }))).toBe("Dimas Arya simulated draft v2 for 2 Nov 2026.");
    expect(activitySentence(e("recon.result_columns", { columns: [] }, { columns: [] }))).toBe("Dimas Arya changed the Operation result columns.");
  });
});

describe("reviewReason", () => {
  const v = { status: "in_review", submitterId: "s", makerId: "m", contributorIds: ["m", "c"] };
  it("maker ≠ checker", () => {
    expect(reviewReason(v, "s", true, "approve")).toBe("You sent this version for approval. Another config checker approves it.");
    expect(reviewReason(v, "c", true, "reject")).toBe("You worked on this version. A config checker who didn't work on it rejects it.");
    expect(reviewReason(v, "x", false, "approve")).toBe("Only a config checker of this space approves recon versions.");
    expect(reviewReason(v, "x", true, "approve")).toBeNull();
    expect(reviewReason({ ...v, status: "draft" }, "x", true, "approve")).toBe("This version is no longer waiting for approval.");
  });
});
