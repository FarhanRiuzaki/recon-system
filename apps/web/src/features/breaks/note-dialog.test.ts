// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import NoteDialog from "./note-dialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("NoteDialog focus once it closes", () => {
  it("after a change was sent, focus lands on the page's target, not the body", async () => {
    document.body.innerHTML = `<main><h1>Item</h1><button id="opener">Request</button><div id="root"></div></main>`;
    const opener = document.getElementById("opener")!;
    opener.focus();
    const root = createRoot(document.getElementById("root")!);
    const props = { title: "Request", description: "It goes for approval.", action: "Send for approval", optional: true, placeholder: "Why", onClose: () => {} };
    await act(async () => root.render(h(NoteDialog, { ...props, landing: ["#next"], onSubmit: async () => {
      // the change re-renders the page: the opener is gone, the next step is there
      opener.remove();
      document.querySelector("main")!.insertAdjacentHTML("beforeend", `<button id="next" data-next="true">Approve</button>`);
    } })));
    const send = [...document.querySelectorAll("button")].find((b) => b.textContent === "Send for approval")!;
    await act(async () => send.click());
    await act(async () => root.render(h("span")));
    await act(() => new Promise((r) => setTimeout(r, 10))); // Radix returns focus a task after unmount
    expect(document.activeElement?.id).toBe("next");
    root.unmount();
  });
});
