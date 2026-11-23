import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StatusChip } from "./status-chip";

/** R5: the crossfade plays only after the value changes; a first render (page load) is the baseline. */
describe("StatusChip change animation", () => {
  it("first render has no data-changed and no reveal animation", () => {
    const out = renderToStaticMarkup(h(StatusChip, { health: "healthy", label: "Healthy" }));
    expect(out).not.toContain("data-changed");
    expect(out).not.toContain("animate-reveal-in");
  });
});

describe("StatusChip In progress (owner 24 Nov: queued, sending, open, running are blue)", () => {
  it("draws the progress mark and ink, a shape of its own", () => {
    const out = renderToStaticMarkup(h(StatusChip, { health: "progress", label: "Queued", strong: true }));
    expect(out).toContain('data-status="progress"');
    expect(out).toContain("text-progress-ink"); expect(out).toContain("bg-progress-soft"); expect(out).toContain("text-progress-mark");
  });
});
