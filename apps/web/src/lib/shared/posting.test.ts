import { describe, expect, it } from "vitest";
import { attentionText, groupChip, groupKeyText, lateGroupsText, POSTING_FILTER, postingChip, postingEvent, postingPipeline, postingPollMs, sendsAtText, waitingText } from "./posting";

describe("posting statuses as people read them", () => {
  it("names each status by its meaning (owner 24 Nov): posted green, failed, timeout and not sent red (each needs a manual posting), no rule / skipped grey, queued and sending blue", () => {
    expect(postingChip("posted")).toEqual({ health: "healthy", label: "Posted" });
    expect(postingChip("failed")).toEqual({ health: "down", label: "Failed" });
    expect(postingChip("not_sent")).toEqual({ health: "down", label: "Not sent" });
    expect(postingChip("timeout")).toEqual({ health: "down", label: "Timeout" });
    expect(postingChip("no_rule")).toEqual({ health: "stopped", label: "No posting rule" });
    expect(postingChip("skipped")).toEqual({ health: "stopped", label: "Skipped" });
    expect(postingChip("queued")).toEqual({ health: "progress", label: "Waiting to send" });
    expect(postingChip("sending")).toEqual({ health: "progress", label: "Sending" });
  });
  it("reads the event that fired an action", () => {
    expect(postingEvent({ event: "level_approved", level: 2 })).toBe("Level 2 approved");
    expect(postingEvent({ event: "approved", level: null })).toBe("Approved");
    expect(postingEvent({ event: "rejected", level: null })).toBe("Rejected");
  });
  it("offers the statuses that need someone's attention first in the filter", () => {
    expect(POSTING_FILTER.map((o) => o.value).slice(0, 3)).toEqual(["failed", "timeout", "not_sent"]);
  });
  it("a posting group's status: Open, Closing while its run waits, then its run's result; empty sends nothing", () => {
    const g = (status: "open" | "closed", run: string | null) => ({ status, run: run ? { status: run as never } : null });
    expect(groupChip(g("open", null))).toEqual({ health: "progress", label: "Open" });
    expect(groupChip(g("closed", "queued"))).toEqual({ health: "progress", label: "Closing" });
    expect(groupChip(g("closed", "sending"))).toEqual({ health: "progress", label: "Closing" });
    expect(groupChip(g("closed", "posted"))).toEqual({ health: "healthy", label: "Posted" });
    expect(groupChip(g("closed", null))).toEqual({ health: "stopped", label: "Nothing to send" });
    expect(groupChip({ ...g("open", null), late: true })).toEqual({ health: "degraded", label: "Open past its close" });
  });
  it("a group key's date value reads like any other date", () => {
    expect(groupKeyText([{ label: "Business date", value: "2026-11-23" }, { label: "Merchant id", value: "0012345" }])).toMatch(/^Business date 23 Nov( 2026)? · Merchant id 0012345$/);
  });
  it("a recon's groups open past their close, in words", () => {
    expect(lateGroupsText(1)).toBe("1 posting group open past its close");
    expect(lateGroupsText(3)).toBe("3 posting groups open past their close");
  });
  it("when a group is sent: its cutoff time or the day's close", () => {
    expect(sendsAtText({ at: "day_close", closesAt: null })).toBe("At day close");
    expect(sendsAtText({ at: "cutoff", closesAt: "2026-11-23T09:00:00.000Z" })).toMatch(/16[.:]00/);
  });
  it("a break waiting in its group, in a sentence", () => {
    const grp = { period: "2026-11-23", keys: [{ label: "Merchant id", value: "0012345" }], at: "cutoff" as const, closesAt: "2026-11-23T09:00:00.000Z" };
    expect(waitingText(grp)).toMatch(/^In the 23 Nov( 2026)? group · Merchant id 0012345 · waiting until 16[.:]00$/);
    expect(waitingText({ ...grp, keys: [{ label: "Merchant id", value: "" }], at: "day_close", closesAt: null })).toMatch(/^In the 23 Nov( 2026)? group · No Merchant id · waiting until day close$/);
  });
  it("sums up a recon's runs that need someone, the non-zero ones only", () => {
    expect(attentionText({ failed: 2, timeout: 1, notSent: 0 })).toBe("2 failed, 1 timeout");
    expect(attentionText({ failed: 0, timeout: 0, notSent: 3 })).toBe("3 not sent");
  });
});

describe("postingPollMs: screens ask again while a posting is on its way", () => {
  it("5 s while one is queued or sending, 15 s while one only waits in a group, else never", () => {
    expect(postingPollMs(["posted", "sending"])).toBe(5_000);
    expect(postingPollMs(["queued"])).toBe(5_000);
    expect(postingPollMs(["grouped", "posted"])).toBe(15_000);
    expect(postingPollMs(["posted", "failed", "timeout", "not_sent", null, undefined])).toBe(false);
    expect(postingPollMs([])).toBe(false);
  });
});

describe("postingPipeline: an action run's steps, Queued → In group → Sending → the bank's answer", () => {
  const base = { queuedAt: "2026-11-24T03:00:00Z", sendingAt: null, finishedAt: null, httpStatus: null, group: null };
  const st = (a: Parameters<typeof postingPipeline>[0]) => postingPipeline(a).map((x) => `${x.label}:${x.status}`);
  it("follows a run from queued to posted, with the HTTP status and how long it took", () => {
    expect(st({ ...base, status: "queued" })).toEqual(["Queued:done", "Sending:todo", "Bank answer:todo"]);
    expect(st({ ...base, status: "sending", sendingAt: "2026-11-24T03:00:01Z" })).toEqual(["Queued:done", "Sending:current", "Bank answer:todo"]);
    const done = postingPipeline({ ...base, status: "posted", sendingAt: "2026-11-24T03:00:01Z", finishedAt: "2026-11-24T03:00:03.5Z", httpStatus: 200 });
    expect(done.map((x) => `${x.label}:${x.status}`)).toEqual(["Queued:done", "Sending:done", "Posted:done"]);
    expect(done[2]!.description).toMatch(/^HTTP 200 · .+ · 2\.5 s$/);
  });
  it("marks a failure or timeout red; a run never sent greys Sending", () => {
    expect(st({ ...base, status: "timeout", sendingAt: base.queuedAt, finishedAt: base.queuedAt })).toEqual(["Queued:done", "Sending:done", "Timeout:error"]);
    expect(st({ ...base, status: "not_sent" })).toEqual(["Queued:done", "Sending:disabled", "Not sent:error"]);
    expect(st({ ...base, status: "skipped" })).toEqual(["Queued:done", "Sending:disabled", "Skipped:disabled"]);
  });
  it("adds the group step for a grouped run: current while it waits, done once sent", () => {
    const group = { id: "g", configId: "c", period: "2026-11-24", keys: [], at: "day_close" as const, closesAt: null, items: 3 };
    expect(st({ ...base, status: "grouped", group })).toEqual(["Queued:done", "In group:current", "Sending:todo", "Bank answer:todo"]);
    expect(postingPipeline({ ...base, status: "posted", group, sendingAt: base.queuedAt, finishedAt: base.queuedAt })[1]!.description).toBe("Sent with 3 items");
  });
});
