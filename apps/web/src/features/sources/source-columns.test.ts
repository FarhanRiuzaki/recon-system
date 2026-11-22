import { createElement as h, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@starterkit/ui/ui/tooltip";
import type { SourceRowDto } from "@starterkit/shared/contracts/sources";
import { sourceColumns } from "./source-columns";

const COLS = sourceColumns("sp-1");
const S: SourceRowDto = {
  id: "s1", spaceId: "sp-1", code: "bi-settlement", name: "BI settlement file", kind: "file_inbox", status: "active", shared: false, publishedVersion: 1, owner: null,
  health: { state: "healthy", businessDate: "2026-11-04", lagSeconds: null, completeThrough: "2026-11-04T17:00:00.000Z", reason: null, missingDate: null, lastError: null, lastReadAt: "2026-11-05T01:00:00.000Z" },
  rowsToday: 9, quarantinedToday: 1, engine: null, server: null, reads: "/inbox/bi · bisettle{yyyyMMdd}.txt", usedByCount: 2, pending: null, recent: [], lastPull: null, nextRunAt: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z",
};
const cell = (key: string, s: SourceRowDto = S) => renderToStaticMarkup(h(TooltipProvider, null, h(Fragment, null, COLS.find((c) => c.key === key)!.cell(s))));

describe("sources columns (audit §5.5 + owner 21 Nov: what it reads, last read, used by)", () => {
  it("in that order; the source is the phone card's title; a tablet keeps Kind and State; Reads hidden until chosen", () => {
    expect(COLS.map((c) => c.header)).toEqual(["Source", "Kind", "Reads", "State", "Complete through", "Last read", "Records today", "Used by"]);
    expect(COLS.map((c) => c.mobile)).toEqual(["title", "meta", "meta", "meta", "meta", "meta", "meta", "meta"]);
    expect(COLS.filter((c) => c.defaultHidden).map((c) => c.key)).toEqual(["reads"]);
    for (const k of ["complete", "lastRead", "rowsToday", "usedBy"]) expect(COLS.find((c) => c.key === k)!.className).toMatch(/\bmd:max-xl:hidden\b/);
  });
  it("Kind names the kind and engine, Reads the table or folder and, for a source admin, the server; Used by counts recons", () => {
    expect(cell("reads")).toContain("/inbox/bi · bisettle{yyyyMMdd}.txt");
    const db = { ...S, kind: "db_watermark" as const, engine: "postgres" as const, reads: "core.source1", server: "recon_ro@db:5432/core" };
    // the kind (with its read mode) and the engine: a neutral chip each (audit §1.1)
    expect(cell("kind", db)).toContain(">Database · watermark</span>");
    expect(cell("kind", db)).toContain(">PostgreSQL</span>");
    expect(cell("kind", db).match(/data-slot="category-chip"/g)).toHaveLength(2);
    expect(cell("reads", db)).toContain("recon_ro@db:5432/core");
    expect(cell("usedBy")).toBe("2 recons");
    expect(cell("name", { ...S, pending: { version: 2, status: "in_review" } })).toContain("version 2 in review");
    expect(cell("lastRead", { ...S, health: { ...S.health!, lastError: "Can't reach the database." } })).toContain("Can&#x27;t reach the database.");
  });
  it("owner 22 Nov: the reason under a state that needs attention, the last pull and the next read, the week and the day before", () => {
    const down = { ...S, health: { ...S.health!, state: "down" as const, reason: "No file for 4 Nov" } };
    expect(cell("state", down)).toContain("No file for 4 Nov");
    expect(cell("state")).not.toContain("line-clamp-2");
    const pulled = { ...S, lastPull: { at: "2026-11-05T01:00:00.000Z", status: "new" as const, added: 4, leftOut: 1, quarantined: 0, error: null }, nextRunAt: "2026-11-05T01:01:00.000Z" };
    expect(cell("lastRead", pulled)).toContain('<span class="text-healthy-ink">+4 rows</span> · 1 left out');
    expect(cell("lastRead", { ...pulled, lastPull: { ...pulled.lastPull, added: 0, leftOut: 0 } })).not.toContain("text-healthy-ink");
    expect(cell("lastRead", pulled)).toContain("Next read 08:01");
    const week = { ...S, recent: [3, 4, 5, 6, 7, 12, 9] };
    expect(cell("rowsToday", week)).toContain("12 the day before");
    expect(cell("rowsToday", week)).toContain("1 quarantined");
    expect(cell("rowsToday", week)).toContain("<svg");
  });
  it("links to the detail; a shared source names its owner, is read-only and has no quarantine count", () => {
    expect(cell("name")).toContain('href="/spaces/sp-1/sources/s1"');
    expect(cell("name")).toContain("Version 1 · bi-settlement");
    const shared = { ...S, shared: true, owner: { spaceId: "t", name: "Treasury" }, quarantinedToday: null };
    expect(cell("name", shared)).toContain("Read-only here · owned by Treasury");
    expect(cell("kind", shared)).toContain("Shared from Treasury");
    // kind, engine and read mode are facts, not states: neutral chips (audit §1.1); a shared source neutral too
    expect(cell("kind")).toContain('data-slot="category-chip"');
    for (const kind of ["file_inbox", "db_watermark", "db_snapshot"] as const) expect(cell("kind", { ...S, kind })).not.toMatch(/bg-chart-\d/);
    expect(cell("kind", shared)).toContain("bg-fg-4");
    expect(cell("state")).toContain('data-status="healthy"');
    expect(cell("state")).toContain("border-transparent");
    expect(cell("rowsToday", shared)).not.toContain("quarantined");
    expect(cell("state")).toContain("Healthy");
    expect(cell("state", { ...S, status: "paused" })).toContain("Paused");
    expect(cell("complete")).toBe("<span class=\"grid whitespace-nowrap\"><span>Through 4 Nov</span></span>");
  });
});
