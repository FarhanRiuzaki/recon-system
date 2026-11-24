import { describe, expect, it } from "vitest";
import { timeRange, patchTimeSearch, refreshInterval, refreshScope, timeWindowDays } from "./time-controls";

describe("navbar time controls", () => {
  const now = Date.UTC(2026, 10, 7, 18);
  it("uses calendar days in the app zone and rejects invalid URL drafts", () => {
    expect(timeRange(new URLSearchParams("range=7d"), 14, now).range).toEqual({ from: "2026-11-02", to: "2026-11-08" });
    expect(timeRange(new URLSearchParams("from=2026-02-30&to=2026-03-01"), 14, now).custom).toBe(false);
  });
  it("range changes reset paging, preserve the table filters and sort", () => {
    expect(patchTimeSearch(new URLSearchParams("page=4&event=login_failed&sort=at&refresh=30"), { range: "30d", from: "", to: "" }).toString()).toBe("event=login_failed&sort=at&refresh=30&range=30d");
  });
  it("refresh does not reset paging, and only accepted intervals are scheduled", () => {
    expect(patchTimeSearch(new URLSearchParams("page=4"), { refresh: "10" }).get("page")).toBe("4");
    expect(refreshInterval("1")).toBe(0); expect(refreshInterval("30")).toBe(30);
  });
  it("pauses on forms and limits refresh to the owning module", () => {
    expect(refreshScope("/users/new")).toBeNull(); expect(refreshScope("/users/id/edit")).toBeNull();
    expect(refreshScope("/me")).toBeNull(); expect(refreshScope("/roles")).toEqual(["rbac"]);
    expect(refreshScope("/audit/auth")).toEqual(["audit"]);
  });
  it("a space's pages with data refresh their modules; a wizard and a recon's builder never (owner, 22 Nov)", () => {
    const sp = "/spaces/s1";
    expect(refreshScope(`${sp}/sources`)).toEqual(["sources"]);
    expect(refreshScope(`${sp}/sources/x`)).toEqual(["sources", "ingest"]);
    expect(refreshScope(`${sp}/sources/new`)).toBeNull();
    expect(refreshScope(`${sp}/sources/x/versions/new`)).toBeNull();
    expect(refreshScope(`${sp}/recons/x`)).toEqual(["recon", "engine"]); // the Overview: its day and runs
    expect(refreshScope(`${sp}/recons/x`, "configuration")).toBeNull(); // the builder
    expect(refreshScope(`${sp}/recons/x/runs/r`)).toEqual(["engine"]);
    expect(refreshScope(`${sp}/today`)).toEqual(["engine"]);
    expect(refreshScope(`${sp}/members`)).toEqual(["spaces"]);
  });
  it("the date range shows where rows are dated: the dashboard, the logs, a source's or a recon's Activity tab", () => {
    expect(timeWindowDays("/")).toBe(7);
    expect(timeWindowDays("/audit/activity")).toBe(7);
    expect(timeWindowDays("/spaces/s1/sources/x", "activity")).toBe(90);
    expect(timeWindowDays("/spaces/s1/recons/x", "history")).toBe(90);
    expect(timeWindowDays("/spaces/s1/recons/x")).toBeNull();
    expect(timeWindowDays("/spaces/s1/sources/x")).toBeNull();
    expect(timeWindowDays("/spaces/s1/today")).toBeNull();
  });
});
