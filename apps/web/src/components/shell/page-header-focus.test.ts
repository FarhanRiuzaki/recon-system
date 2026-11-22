// @vitest-environment happy-dom
import { act, createElement as h, useState } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Dialog, DialogContent, DialogTitle } from "@starterkit/ui/ui/dialog";
import { TooltipProvider } from "@starterkit/ui/ui/tooltip";
import { PageHeader, returnToMore } from "./page-header";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));
vi.mock("@/components/lazy-confirm", async () => ({ LazyConfirmActionDialog: (await import("@starterkit/ui/ds/confirm-action-dialog")).ConfirmActionDialog }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const button = (text: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === text)!;
const more = () => document.querySelector<HTMLButtonElement>('[aria-label="More actions"]')!;
const settle = () => act(() => new Promise((r) => setTimeout(r, 10))); // Radix moves focus a task after unmount
const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')];
/** The menu's Radix chunk loads on demand (deferred-overlay): wait until `ok` holds. */
async function until(ok: () => boolean) { for (let i = 0; i < 100 && !ok(); i++) await settle(); expect(ok()).toBe(true); }
async function openMenu() {
  more().focus();
  await act(async () => more().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  await until(() => items().length > 0);
}

async function openItem(label: string) {
  await openMenu();
  await act(async () => items().find((m) => m.textContent === label)!.click());
  await until(() => !!button("Cancel"));
}

describe("PageHeader ⋯ menu: focus after a destructive item's dialog closes", () => {
  it("the shared confirmation returns focus to the ⋯ trigger, not the body", async () => {
    document.body.innerHTML = `<div id="root"></div>`;
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(h(TooltipProvider, null, h(PageHeader, { title: "Bank API", more: [
      { label: "Discard draft", destructive: true, confirm: { title: "Discard draft 2", description: "It goes.", onConfirm: async () => {} } },
    ] }))));
    await openItem("Discard draft");
    await act(async () => button("Cancel").click());
    await until(() => !button("Cancel"));
    await settle();
    expect(document.activeElement).toBe(more());
    root.unmount();
  });

  it("an item that opens the caller's own dialog (Turn off connector) returns focus to the ⋯ trigger too", async () => {
    document.body.innerHTML = `<div id="root"></div>`;
    function Screen() {
      const [open, setOpen] = useState(false);
      return h(TooltipProvider, null,
        h(PageHeader, { title: "Bank API", more: [{ label: "Turn off connector", destructive: true, onSelect: () => setOpen(true) }] }),
        open && h(Dialog, { open: true, onOpenChange: (o: boolean) => { if (!o) setOpen(false); } },
          h(DialogContent, { onCloseAutoFocus: returnToMore }, h(DialogTitle, null, "Turn off connector"), h("button", { type: "button", onClick: () => setOpen(false) }, "Cancel"))));
    }
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(h(Screen)));
    await openItem("Turn off connector");
    await act(async () => button("Cancel").click());
    await until(() => !button("Cancel"));
    await settle();
    expect(document.activeElement).toBe(more());
    root.unmount();
  });

  it("an item with its own dialog (Turn off connector) is a menu item, not a header button", async () => {
    document.body.innerHTML = `<div id="root"></div>`;
    const root = createRoot(document.getElementById("root")!);
    await act(async () => root.render(h(TooltipProvider, null, h(PageHeader, { title: "Bank API", more: [
      { label: "Turn off connector", destructive: true, onSelect: () => {} },
    ] }))));
    expect(button("Turn off connector")).toBeUndefined();
    await openMenu();
    expect(items().map((m) => m.textContent)).toEqual(["Turn off connector"]);
    root.unmount();
  });
});
