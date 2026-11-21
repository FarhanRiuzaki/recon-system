import { describe, expect, it } from "vitest";
import { reconCaption } from "./recon-columns";

describe("reconCaption: the list's second line says the recon's state as its chip does", () => {
  it("names the published version, else the open version's state", () => {
    expect(reconCaption({ publishedVersion: 2, draftStatus: null, code: "bifast" })).toBe("Version 2 · bifast");
    // a version waiting behind the live one says so, as the sources list does (owner, 22 Nov)
    expect(reconCaption({ publishedVersion: 2, draftStatus: "in_review", code: "bifast" })).toBe("Version 2 · bifast · a new version in review");
    expect(reconCaption({ publishedVersion: 2, draftStatus: "draft", code: "bifast" })).toBe("Version 2 · bifast · a new version drafted");
    expect(reconCaption({ publishedVersion: null, draftStatus: "in_review", code: "abc" })).toBe("In review · abc");
    expect(reconCaption({ publishedVersion: null, draftStatus: "draft", code: "abc" })).toBe("Draft · abc");
  });
});

import type { LiveReconDto, ReconRowDto } from "@starterkit/shared/contracts/recon";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { reconColumns } from "./recon-columns";

describe("the recons list's live columns (owner, 22 Nov: as the sources list)", () => {
  const row: ReconRowDto = { id: "r1", spaceId: "s", code: "bifast", name: "BI-FAST", status: "active", publishedVersion: 1, draftStatus: null, createdAt: "2026-11-01T00:00:00.000Z" };
  const live: LiveReconDto = {
    id: "r1", name: "BI-FAST", sides: [{ label: "Core", sourceId: "a" }, { label: "Switch", sourceId: "b" }], schedule: { kind: "interval", every_minutes: 2 },
    date: "2026-11-22", state: "open", runId: "x", runAt: null, lastSuccessAt: "2026-11-22T00:00:00.000Z", stale: false, alertedAt: null, running: null, openBreaks: 7,
    day: { date: "2026-11-22", passes: { 1: { matched: 90, suggested: 4, broken: 0, brokenRefs: 0 } }, open: { a: 6, b: 2 }, breaks: { a: 0, b: 0 }, items: { a: 100, b: 98 }, closed: false },
  };
  const health = (state: "healthy" | "down") => ({ state, businessDate: "2026-11-22", lagSeconds: null, completeThrough: null, reason: null, missingDate: null, lastError: null, lastReadAt: null });
  const index = { recons: new Map([["r1", live]]), sources: new Map([["a", { id: "a", name: "Core banking", health: health("healthy"), rowsToday: 100 }], ["b", { id: "b", name: "Switch settle", health: health("down"), rowsToday: 98 }]]) };
  const cell = (key: string, l: typeof index | null = index) => renderToStaticMarkup(createElement("div", null, reconColumns("s", l).find((c) => c.key === key)!.cell(row)));
  it("the sources with a bad one named, how often it runs, the day, match rate, waiting and open breaks", () => {
    expect(cell("sides")).toContain("Core banking");
    expect(cell("sides")).toContain("Down");
    expect(cell("schedule")).toContain("Every 2 min");
    expect(cell("today")).toContain("Source down");
    expect(cell("rate")).toContain("90%");
    expect(cell("waiting")).toContain("4 suggested");
    expect(cell("breaks")).toContain("7");
  });
  it("a dash while Today loads or for a recon without an approved version", () => {
    for (const k of ["sides", "schedule", "today", "lastRun", "rate", "waiting", "breaks"]) expect(cell(k, null)).toContain("—");
  });
});
