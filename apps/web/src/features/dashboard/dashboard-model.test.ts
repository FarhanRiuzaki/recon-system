import { describe, expect, it } from "vitest";
import type { PermissionName } from "@starterkit/shared/permissions";
import { selectionState } from "@starterkit/shared/filter-selection";
import { readTable } from "@/lib/shared/table-state";
import { ACTION_RUNS } from "@/lib/shared/queries";
import { BREAKS, RESULTS } from "@/lib/shared/queries-recon";
import { adminSection, approvalsHref, countDelta, idrHeadline, linkSpace, onTimeRate, pendingNotice, postingFailedHref, rate, rateDelta, resultsHref, sourceHref, sourcesEmpty, unmatchHref } from "./dashboard-model";

const has = (...ps: PermissionName[]) => (p: PermissionName) => ps.includes(p);
const search = (href: string) => new URLSearchParams(href.split("?")[1] ?? "");
const P = { from: "2026-11-02", to: "2026-11-03" };

describe("recon dashboard model", () => {
  it("sources: the on-time rate leaves unknown dates out; a row opens the source's page in its space", () => {
    expect(onTimeRate({ onTime: 3, late: 1, missing: 0, unknown: 9 })).toBe(0.75);
    expect(onTimeRate({ onTime: 1, late: 1, missing: 2, unknown: 0 })).toBe(0.25);
    expect(onTimeRate({ onTime: 0, late: 0, missing: 0, unknown: 4 })).toBeNull();
    expect(sourceHref("s 1", "x")).toBe("/spaces/s%201/sources/x");
  });

  it("sources: no rows says why, a recon picked that reads none in its own words", () => {
    expect(sourcesEmpty(null)).toEqual({ title: "No sources yet", description: "A source shows here once it has a published version in one of your spaces." });
    expect(sourcesEmpty("r1")).toEqual({ title: "This recon reads no sources", description: "Its sources show here once a published version of it reads one." });
  });

  it("the admin section is for holders of user.view or audit.view only", () => {
    expect(adminSection(has())).toBe(false);
    expect(adminSection(has("role.view"))).toBe(false);
    expect(adminSection(has("user.view"))).toBe(true);
    expect(adminSection(has("audit.view"))).toBe(true);
  });

  it("dates whose rollup is still computing are named, never shown as final (C2)", () => {
    expect(pendingNotice({ days: 0, prevDays: 0 })).toBeNull();
    expect(pendingNotice({ days: 1, prevDays: 0 })).toBe("Still computing 1 day of this period. Its numbers show as pending until they are in.");
    expect(pendingNotice({ days: 3, prevDays: 2 })).toBe("Still computing 3 days of this period and 2 days of the one before. Their numbers show as pending until they are in.");
    expect(pendingNotice({ days: 0, prevDays: 1 })).toBe("Still computing 1 day of the period before. Changes against it show once it is in.");
  });

  it("the headline is IDR; other currencies stay apart, never added in", () => {
    expect(idrHeadline([{ currency: "USD", amountMinor: "700", items: 1 }, { currency: "IDR", amountMinor: "150000", items: 2 }]))
      .toEqual({ value: "1,500.00", others: ["7.00 USD"] });
    expect(idrHeadline([{ currency: "USD", amountMinor: "700", items: 1 }]).value).toBe("0.00");
  });

  it("rates and changes: points for a rate, a count for a count, nothing to compare without data", () => {
    expect(rate(1, 4)).toBe(0.25);
    expect(rate(0, 0)).toBeNull();
    expect(rateDelta(0.5, 0.25, "up")).toEqual({ text: "+25 pts vs previous period", direction: "up", good: "up" });
    expect(rateDelta(0.5, null, "up")).toBeUndefined();
    expect(countDelta(3, 5, "down")).toEqual({ text: "−2 vs previous period", direction: "down", good: "down" });
    // what the change counts, when the tile shows something else (M2: Unmatch open shows the open amount)
    expect(countDelta(5, 2, "down", "new unmatch").text).toBe("+3 new unmatch vs previous period");
    // a big change stays short, so its pill fits beside the tile label (24 Nov: "+12,884" pushed the label to two lines)
    expect(countDelta(12_884, 0, "down").text).toBe("+12.9K vs previous period");
    expect(countDelta(0, 12_884, "down").text).toBe("−12.9K vs previous period");
  });

  it("each link opens its list with the same filters the number counted", () => {
    expect(readTable(search(unmatchHref("s", { recon: "r1", age: ["d0", "d1"] })), BREAKS("s").spec)).toMatchObject({ recon: selectionState(["r1"]), age: selectionState(["d0", "d1"]) });
    const res = readTable(search(resultsHref("s", "r1", P, ["matched"])), RESULTS("s", "r1").spec);
    expect([res.recon, res.dateFrom, res.dateTo, res.result]).toEqual(["r1", P.from, P.to, selectionState(["matched"])]);
    const post = readTable(search(postingFailedHref("s", P, "r1")), ACTION_RUNS("s").spec);
    expect([post.kind, post.recon, post.dateFrom, post.dateTo, post.status]).toEqual(["posting", selectionState(["r1"]), P.from, P.to, selectionState(["failed", "timeout", "not_sent"])]);
    expect(search(approvalsHref("s")).get("mine")).toBe("0");
  });

  it("a number links only when one space is in scope", () => {
    expect(linkSpace({ spaces: [{ id: "a", name: "A" }] }, null)).toBe("a");
    expect(linkSpace({ spaces: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }, null)).toBeNull();
    expect(linkSpace({ spaces: [{ id: "a", name: "A" }, { id: "b", name: "B" }] }, "b")).toBe("b");
  });
});
