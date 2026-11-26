import { describe, expect, it } from "vitest";
import { BREAK_REASONS, BREAK_STATES } from "@starterkit/shared/recon";
import { REQUEST_KINDS } from "@starterkit/shared/approvals";
import { ENVIRONMENTS } from "@starterkit/shared/integrations";
import { SPACE_ROLES } from "@starterkit/shared/spaces";
import { CATEGORIES, categoryChip, STATES, STATUS_TONE, statusChip, statusChips, statusTone } from "./categories";

describe("status tones (owner 24 Nov): one map from a status's meaning to its chip colour", () => {
  it("success, new data, posted, healthy, matched green; error, failed, timeout, refused red; warning, degraded, stale, late amber", () => {
    for (const m of ["success", "new_data", "posted", "healthy", "matched"] as const) expect(statusTone(m), m).toBe("healthy");
    // not sent needs a manual posting: it sits in Posting's attention list with Failed and Timeout (review 24 Nov)
    for (const m of ["error", "failed", "timeout", "refused", "not_sent"] as const) expect(statusTone(m), m).toBe("down");
    for (const m of ["warning", "degraded", "stale", "late"] as const) expect(statusTone(m), m).toBe("degraded");
  });
  it("nothing, idle, skipped, no rule grey; in progress, queued, sending, open blue", () => {
    for (const m of ["nothing", "idle", "skipped", "no_rule"] as const) expect(statusTone(m), m).toBe("stopped");
    for (const m of ["in_progress", "queued", "sending", "open"] as const) expect(statusTone(m), m).toBe("progress");
  });
  it("each meaning has exactly one tone; statusChip pairs it with the words", () => {
    expect(new Set(Object.keys(STATUS_TONE)).size).toBe(Object.keys(STATUS_TONE).length);
    // green = it worked or it is done; a new problem is never green
    expect(STATUS_TONE).not.toHaveProperty("new");
    expect(statusChip("new_data", "New rows")).toEqual({ health: "healthy", label: "New rows" });
  });
  it("a break's work state, a recon's day and a sign-off stage are statuses: New and open work blue, only done green", () => {
    expect(BREAK_STATES.map((s) => STATES.workState[s])).toEqual(["progress", "progress", "progress", "progress", "progress", "progress", "healthy"]);
    expect(["open", "prepared", "signed"].map((d) => STATES.dayState[d as "open"])).toEqual(["progress", "progress", "healthy"]);
    expect(["open", "prepared", "signed"].map((x) => STATES.signoffStage[x as "open"])).toEqual(["progress", "progress", "healthy"]);
  });
});

describe("categories (audit §1.1 chip map): one slot per categorical value, never a status colour", () => {
  it("reason, change kind, environment and space role map as the chip map says", () => {
    expect(categoryChip("reason", "No counterpart")).toBe("neutral");
    expect(categoryChip("reason", "Amount differs")).toBe("violet");
    expect(categoryChip("reason", "Date differs")).toBe("indigo");
    expect(categoryChip("reason", "Duplicate")).toBe("pink");
    expect(REQUEST_KINDS.map((k) => categoryChip("changeKind", k))).toEqual(["indigo", "violet", "brown", "pink"]);
    expect(categoryChip("changeKind", "source_version")).toBe("neutral");
    expect(ENVIRONMENTS.map((e) => categoryChip("environment", e))).toEqual(["neutral", "violet"]);
    expect(SPACE_ROLES.map((r) => categoryChip("spaceRole", r))).toEqual(["violet", "indigo", "teal", "pink", "slate", "brown", "neutral"]);
  });
  it("every role and every reason a hue of its own (review 24 Nov: Space admin ≠ Source admin, Config maker ≠ Operator, Config checker ≠ Reviewer)", () => {
    for (const domain of ["spaceRole", "reason"] as const) {
      const hues = Object.values(CATEGORIES[domain]).filter((s) => s !== "neutral");
      expect(new Set(hues).size, domain).toBe(hues.length);
    }
  });
  it("every value of each vocabulary has a slot (a new value fails here, not silently grey)", () => {
    for (const r of BREAK_REASONS) expect(categoryChip("reason", r)).toBeDefined();
    for (const r of SPACE_ROLES) expect(CATEGORIES.spaceRole).toHaveProperty(r);
    for (const e of ENVIRONMENTS) expect(CATEGORIES.environment).toHaveProperty(e);
    for (const s of BREAK_STATES) expect(STATES.workState).toHaveProperty(s);
  });
  it("an action's kind: posting as the posting change kind, notify neutral", () => {
    expect(["posting", "notify"].map((k) => categoryChip("actionKind", k))).toEqual(["indigo", "neutral"]);
    expect(categoryChip("actionKind", "posting")).toBe(categoryChip("changeKind", "posting"));
  });
  it("no category takes a chart slot: 1 (blue) reads as In progress, 2 / 3 / 5 as Degraded or Healthy; categories take the cat- hues", () => {
    for (const [domain, map] of Object.entries(CATEGORIES)) for (const slot of Object.values(map)) expect(typeof slot, `${domain} ${String(slot)}`).toBe("string");
  });
  it("an unknown value is neutral", () => {
    expect(categoryChip("reason", "Something new")).toBe("neutral");
    expect(categoryChip("spaceRole", "owner")).toBe("neutral");
  });
});

describe("statusChips: a domain's colour and words on one row", () => {
  it("the caller passes the domain key only; the meaning and the label come from the same row", () => {
    const chip = statusChips<"ok" | "bad">({ ok: ["success", "Answered"], bad: ["failed", "Failed"] });
    expect(chip("ok")).toEqual({ health: "healthy", label: "Answered" });
    expect(chip("bad")).toEqual({ health: "down", label: "Failed" });
  });
});
