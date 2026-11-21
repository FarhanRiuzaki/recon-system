import { createElement as h, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@starterkit/ui/ui/tooltip";
import type { SourceRowDto } from "@starterkit/shared/contracts/sources";
import { sourceColumns } from "./source-columns";

const COLS = sourceColumns("sp-1");
const S: SourceRowDto = {
  id: "s1", spaceId: "sp-1", code: "bi-settlement", name: "BI settlement file", kind: "file_inbox", status: "active", shared: false, publishedVersion: 1, owner: null,
  health: { state: "healthy", businessDate: "2026-11-04", lagSeconds: null, completeThrough: "2026-11-04T17:00:00.000Z", reason: null, missingDate: null, lastError: null },
  rowsToday: 9, quarantinedToday: 1, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
};
const cell = (key: string, s: SourceRowDto = S) => renderToStaticMarkup(h(TooltipProvider, null, h(Fragment, null, COLS.find((c) => c.key === key)!.cell(s))));

describe("sources columns (Build notes 02: Source · Kind · State · Complete through · Quarantined today)", () => {
  it("in that order with records today; the source is the phone card's title; a tablet keeps Kind and State", () => {
    expect(COLS.map((c) => c.header)).toEqual(["Source", "Kind", "State", "Complete through", "Records today", "Quarantined today"]);
    expect(COLS.map((c) => c.mobile)).toEqual(["title", "meta", "meta", "meta", "meta", "meta"]);
    for (const k of ["complete", "rowsToday", "quarantinedToday"]) expect(COLS.find((c) => c.key === k)!.className).toMatch(/\bmd:max-xl:hidden\b/);
  });
  it("links to the detail; a shared source names its owner, is read-only and has no quarantine count", () => {
    expect(cell("name")).toContain('href="/spaces/sp-1/sources/s1"');
    expect(cell("name")).toContain("Version 1 · bi-settlement");
    const shared = { ...S, shared: true, owner: { spaceId: "t", name: "Treasury" }, quarantinedToday: null };
    expect(cell("name", shared)).toContain("Read-only here · owned by Treasury");
    expect(cell("kind", shared)).toContain("Shared from Treasury");
    // a category chip per input kind, the same slot in every row; a shared source neutral (Figma 02 v1.0.6)
    expect(cell("kind")).toContain('data-slot="category-chip"');
    expect(cell("kind")).toContain("bg-chart-1");
    expect(cell("kind", { ...S, kind: "db_watermark" })).toContain("bg-chart-4");
    expect(cell("kind", { ...S, kind: "db_snapshot" })).toContain("bg-chart-4");
    expect(cell("kind", shared)).toContain("bg-fg-4");
    expect(cell("state")).toContain('data-status="healthy"');
    expect(cell("state")).toContain("border-transparent");
    expect(cell("quarantinedToday", shared)).toContain("—");
    expect(cell("state")).toContain("Healthy");
    expect(cell("state", { ...S, status: "paused" })).toContain("Paused");
    expect(cell("complete")).toBe("<span class=\"grid\"><span>Through 4 Nov</span></span>");
  });
});
