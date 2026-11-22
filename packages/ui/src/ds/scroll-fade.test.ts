// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { ScrollFade } from "./scroll-fade";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("ScrollFade (owner rule: every region that scrolls fades where it goes on)", () => {
  it("shows the fade on each side with hidden content, and on scroll moves it", async () => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(h(ScrollFade, { className: "h-20" }, h("div", null, "rows"))));
    const box = host.querySelector<HTMLElement>("[data-slot=scroll-fade] > div")!;
    const size = (o: Record<string, number>) => { for (const [k, v] of Object.entries(o)) Object.defineProperty(box, k, { value: v, configurable: true, writable: true }); };
    const on = () => [...host.querySelectorAll("[data-slot=scroll-fade-edge]")].filter((x) => x.hasAttribute("data-on")).map((x) => x.getAttribute("data-side"));
    size({ scrollHeight: 300, clientHeight: 80, scrollTop: 0, scrollWidth: 100, clientWidth: 100, scrollLeft: 0 });
    await act(async () => { box.dispatchEvent(new Event("scroll")); });
    expect(on()).toEqual(["bottom"]);
    size({ scrollTop: 100 });
    await act(async () => { box.dispatchEvent(new Event("scroll")); });
    expect(on()).toEqual(["top", "bottom"]);
    size({ scrollTop: 220 });
    await act(async () => { box.dispatchEvent(new Event("scroll")); });
    expect(on()).toEqual(["top"]);
    expect([...host.querySelectorAll("[data-slot=scroll-fade-edge]")].every((x) => x.getAttribute("aria-hidden") === "true")).toBe(true);
    await act(async () => root.unmount());
  });
  it("focusable: a named region in the tab order while it overflows (keyboard scrolling), out of it while it fits", async () => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(h(ScrollFade, { focusable: true, "aria-label": "Comparison" }, h("table", null))));
    const box = host.querySelector<HTMLElement>("[data-slot=scroll-fade] > div")!;
    const size = (o: Record<string, number>) => { for (const [k, v] of Object.entries(o)) Object.defineProperty(box, k, { value: v, configurable: true, writable: true }); };
    expect(box.getAttribute("tabindex")).toBeNull();
    expect(box.getAttribute("aria-label")).toBe("Comparison");
    size({ scrollHeight: 80, clientHeight: 80, scrollTop: 0, scrollWidth: 600, clientWidth: 300, scrollLeft: 0 });
    await act(async () => { box.dispatchEvent(new Event("scroll")); });
    expect(box.getAttribute("tabindex")).toBe("0");
    expect(box.getAttribute("role")).toBe("region");
    size({ scrollWidth: 300 });
    await act(async () => { box.dispatchEvent(new Event("scroll")); });
    expect(box.getAttribute("tabindex")).toBeNull();
    await act(async () => root.unmount());
  });
});
