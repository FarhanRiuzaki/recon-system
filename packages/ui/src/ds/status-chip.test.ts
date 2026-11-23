import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusChip, type StatusChipProps } from "./status-chip";
import type { LegendItem } from "./status-legend";
import { type Health, toStatusTone } from "../lib/status";

/** R5: the crossfade plays only after the value changes; a first render (page load) is the baseline. */
describe("StatusChip change animation", () => {
  it("first render has no data-changed and no reveal animation", () => {
    const out = renderToStaticMarkup(h(StatusChip, { health: toStatusTone("healthy"), label: "Healthy" }));
    expect(out).not.toContain("data-changed");
    expect(out).not.toContain("animate-reveal-in");
  });
});

describe("StatusChip In progress (owner 24 Nov: queued, sending, open, running are blue)", () => {
  it("draws the progress mark and ink, a shape of its own", () => {
    const out = renderToStaticMarkup(h(StatusChip, { health: toStatusTone("progress"), label: "Queued", strong: true }));
    expect(out).toContain('data-status="progress"');
    expect(out).toContain("text-progress-ink"); expect(out).toContain("bg-progress-soft"); expect(out).toContain("text-progress-mark");
  });
});

/**
 * A status tone is a branded type (review 24 Nov): only the shared meaning map (apps/web lib/shared/categories.ts) and
 * the design system make one, so a literal, a cast to Health or a hand-written map fails typecheck, whatever the
 * prop is called or however many lines the map spans.
 */
describe("StatusChip takes a branded tone, never a bare Health", () => {
  it("refuses a literal and a Health; takes a tone the map made", () => {
    const bare: Health = "down";
    // @ts-expect-error a literal is not a StatusTone
    const a: StatusChipProps = { health: "down", label: "Failed" };
    // @ts-expect-error a Health (or `as Health`) is not a StatusTone
    const b: StatusChipProps = { health: bare, label: "Failed" };
    // @ts-expect-error a legend entry too
    const c: LegendItem = { health: "healthy", label: "Healthy" };
    const ok: StatusChipProps = { health: toStatusTone("down"), label: "Failed" };
    expect([a, b, c, ok].map((x) => x.health)).toEqual(["down", "down", "healthy", "down"]);
  });
});
