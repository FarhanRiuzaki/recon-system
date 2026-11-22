// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FullScreenEditor } from "./full-screen-editor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; document.body.innerHTML = ""; });

describe("FullScreenEditor (a full-screen editor)", () => {
  it("a modal dialog named by its title, with its rail, main area, inspector and dock as labelled regions", async () => {
    const el = document.createElement("div"); document.body.append(el); root = createRoot(el);
    await act(async () => root!.render(h(FullScreenEditor, {
      open: true, onOpenChange: () => {}, title: "Post to GL", description: "Write-off · approved",
      actions: h("button", null, "Done"), rail: h("p", null, "settings"), inspector: h("p", null, "field"), dock: h("p", null, "preview"), children: h("p", null, "canvas"),
    })));
    const d = document.querySelector('[role="dialog"]')!;
    expect(d.getAttribute("data-slot")).toBe("full-screen-editor");
    expect(d.getAttribute("aria-labelledby") && document.getElementById(d.getAttribute("aria-labelledby")!)?.textContent).toBe("Post to GL");
    for (const name of ["Settings", "Inspector", "Preview"]) expect(d.querySelector(`[aria-label="${name}"]`), name).not.toBeNull();
    expect(d.textContent).toContain("canvas");
    // each scrolling region fades where content is hidden past it (owner rule; final review I6)
    for (const name of ["Settings", "Inspector", "Preview"]) expect(d.querySelector(`[aria-label="${name}"] [data-slot="scroll-fade"]`), name).not.toBeNull();
  });
  it("Escape asks the caller to close (it may refuse, e.g. unsaved changes)", async () => {
    const onOpenChange = vi.fn();
    const el = document.createElement("div"); document.body.append(el); root = createRoot(el);
    await act(async () => root!.render(h(FullScreenEditor, { open: true, onOpenChange, title: "T", actions: null, children: null })));
    await act(async () => { document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
