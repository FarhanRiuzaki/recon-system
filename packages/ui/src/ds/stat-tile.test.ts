import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatTile } from "./stat-tile";

/** R6: a tile given `tween` renders the NumberTween structure (aria-hidden animated text + sr-only final value). */
describe("StatTile tween", () => {
  const fmt = (v: number) => `${Math.round(v)} req`;
  it("renders an aria-hidden span plus an sr-only span with the formatted final value", () => {
    const out = renderToStaticMarkup(h(StatTile, { label: "AI requests", value: "ignored", tween: { value: 42, format: fmt } }));
    expect(out).toContain('<span aria-hidden="true">42 req</span>');
    expect(out).toContain('<span class="sr-only">42 req</span>');
    expect(out).not.toContain("ignored");
  });
  it("without tween the plain value is shown and there is no sr-only duplicate", () => {
    const out = renderToStaticMarkup(h(StatTile, { label: "Days", value: "3 of 7" }));
    expect(out).toContain("3 of 7");
    expect(out).not.toContain("sr-only");
  });
});

describe("StatTile as a filter", () => {
  it("with onSelect it is a toggle button whose aria-pressed follows selected; without it a plain block", () => {
    const on = renderToStaticMarkup(h(StatTile, { label: "Healthy", value: "3", onSelect: () => {}, selected: true }));
    expect(on).toMatch(/^<button[^>]*type="button"[^>]*aria-pressed="true"/);
    expect(on).toContain("border-primary");
    const off = renderToStaticMarkup(h(StatTile, { label: "Healthy", value: "3", onSelect: () => {} }));
    expect(off).toContain('aria-pressed="false"');
    expect(renderToStaticMarkup(h(StatTile, { label: "Healthy", value: "3" }))).toMatch(/^<div/);
  });
});

describe("a KPI value never wider than its tile (audit 2 A11)", () => {
  it("a long number shows compact, the exact value in a tooltip and for screen readers", async () => {
    const { fitStat } = await import("./stat-tile");
    expect(fitStat("140,932,891,500.00")).toEqual({ shown: "140.9B", exact: "140,932,891,500.00" });
    expect(fitStat("88,879,542,000.00")).toEqual({ shown: "88.9B", exact: "88,879,542,000.00" });
    expect(fitStat("-2,481,000,000")).toEqual({ shown: "−2.5B", exact: "-2,481,000,000" });
    expect(fitStat("6,046")).toEqual({ shown: "6,046", exact: null });
    expect(fitStat("35,000.00")).toEqual({ shown: "35,000.00", exact: null });
    expect(fitStat("3 of 7")).toEqual({ shown: "3 of 7", exact: null });
    expect(fitStat("A long caption-like value")).toEqual({ shown: "A long caption-like value", exact: null });
  });
  it("renders the compact value with the exact one as its title and an sr-only copy", () => {
    const out = renderToStaticMarkup(h(StatTile, { label: "Open amount", value: "88,879,542,000.00", unit: "IDR" }));
    expect(out).toContain('title="88,879,542,000.00 IDR"');
    expect(out).toContain('<span aria-hidden="true">88.9B</span>');
    expect(out).toContain('<span class="sr-only">88,879,542,000.00</span>');
  });
});
