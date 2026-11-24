// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { LiveCountBadge, nextLiveCount } from "./live-count";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });
const render = (value: number, tone?: "neutral" | "progress" | "down") => act(async () => root!.render(h(LiveCountBadge, { value, tone, format: String })));
const badge = () => host.querySelector("[data-slot='live-count']");

describe("nextLiveCount", () => {
  it("the first value is the baseline; each later change counts up and remembers where it came from", () => {
    const a = nextLiveCount(null, 5);
    expect(a).toEqual({ value: 5, from: 5, n: 0 });
    expect(nextLiveCount(a, 5)).toBe(a);
    expect(nextLiveCount(a, 7)).toEqual({ value: 7, from: 5, n: 1 });
  });
});

describe("LiveCountBadge", () => {
  it("fades in on its first render without the pop; a changed count pops once, an unchanged one does not replay", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await render(5);
    expect(badge()?.className).toContain("animate-fade");
    expect(badge()?.className).not.toContain("animate-pop");
    expect(badge()?.textContent).toContain("5");
    await render(7);
    const popped = badge();
    expect(popped?.className).toContain("animate-pop");
    await render(7);
    expect(badge()).toBe(popped); // same element: the pop isn't replayed by a re-render
  });

  it("0 shows nothing; a count that comes back pops; the tone colours the pill; the badge is hidden from screen readers", async () => {
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    await render(2, "down");
    expect(badge()?.getAttribute("aria-hidden")).toBe("true");
    expect(badge()?.querySelector("[data-slot='count-badge']")?.className).toContain("bg-down-soft");
    await render(0, "down");
    expect(badge()).toBeNull();
    await render(3, "down");
    expect(badge()?.className).toContain("animate-pop");
  });
});
