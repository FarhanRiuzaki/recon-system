import { describe, expect, it } from "vitest";
import { BREAK_REASONS, BREAK_STATES } from "@starterkit/shared/recon";
import { REQUEST_KINDS } from "@starterkit/shared/approvals";
import { ENVIRONMENTS } from "@starterkit/shared/integrations";
import { SPACE_ROLES } from "@starterkit/shared/spaces";
import { CATEGORIES, categoryChip } from "./categories";

describe("categories (audit §1.1 chip map): one slot per categorical value, never a health colour", () => {
  it("work state, reason, change kind, environment and space role map as the chip map says", () => {
    expect(BREAK_STATES.map((s) => categoryChip("workState", s))).toEqual(["neutral", 1, 1, 5, 3, 4, 3]);
    expect(categoryChip("reason", "No counterpart")).toBe("neutral");
    expect(categoryChip("reason", "Amount differs")).toBe(2);
    expect(categoryChip("reason", "Date differs")).toBe(5);
    expect(categoryChip("reason", "Duplicate")).toBe(6);
    expect(REQUEST_KINDS.map((k) => categoryChip("changeKind", k))).toEqual([1, 4, 6, 2]);
    expect(categoryChip("changeKind", "source_version")).toBe("neutral");
    expect(ENVIRONMENTS.map((e) => categoryChip("environment", e))).toEqual(["neutral", 2]);
    expect(SPACE_ROLES.map((r) => categoryChip("spaceRole", r))).toEqual([4, 3, 1, 6, 5, 2, "neutral"]);
  });
  it("every value of each vocabulary has a slot (a new value fails here, not silently grey)", () => {
    for (const s of BREAK_STATES) expect(CATEGORIES.workState).toHaveProperty(s);
    for (const r of BREAK_REASONS) expect(categoryChip("reason", r)).toBeDefined();
    for (const r of SPACE_ROLES) expect(CATEGORIES.spaceRole).toHaveProperty(r);
    for (const e of ENVIRONMENTS) expect(CATEGORIES.environment).toHaveProperty(e);
  });
  it("an action's kind and a recon's day state: posting as the posting change kind, a day open neutral, never health", () => {
    expect(["posting", "notify"].map((k) => categoryChip("actionKind", k))).toEqual([1, "neutral"]);
    expect(categoryChip("actionKind", "posting")).toBe(categoryChip("changeKind", "posting"));
    expect(["open", "closing", "closed"].map((d) => categoryChip("dayState", d))).toEqual(["neutral", 4, 1]);
  });
  it("a day state never takes slot 2, 3 or 5: beside a Stale / Source down chip they read as Degraded or Healthy (§1.1)", () => {
    for (const slot of Object.values(CATEGORIES.dayState)) expect([2, 3, 5]).not.toContain(slot);
  });
  it("an unknown value is neutral", () => {
    expect(categoryChip("workState", "archived")).toBe("neutral");
    expect(categoryChip("reason", "Something new")).toBe("neutral");
  });
});
