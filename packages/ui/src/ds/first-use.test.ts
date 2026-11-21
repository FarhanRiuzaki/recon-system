// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { focusNew, useFirstUse } from "./first-use";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { localStorage.clear(); document.body.innerHTML = ""; });

describe("useFirstUse (attention shimmer until first used)", () => {
  it("fresh until used, then not, also for another component reading the same action; per action", async () => {
    const seen: boolean[] = [];
    let use: () => void = () => {};
    function Probe() { const [fresh, used] = useFirstUse("demo.add"); seen.push(fresh); use = used; return h("span", null, String(fresh)); }
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(h(Probe)));
    expect(host.textContent).toBe("true");
    await act(async () => use());
    expect(host.textContent).toBe("false");
    expect(localStorage.getItem("ui:used:demo.add")).toBe("1");
    expect(localStorage.getItem("ui:used:other")).toBeNull();
    await act(async () => root.unmount());
  });
});

describe("focusNew (a section an action adds takes the focus)", () => {
  it("focuses the element once it appears a frame later", async () => {
    focusNew("late-field");
    const input = document.createElement("input"); input.id = "late-field";
    input.scrollIntoView = () => {};
    document.body.append(input);
    await new Promise((r) => setTimeout(r, 50));
    expect(document.activeElement).toBe(input);
  });
});
