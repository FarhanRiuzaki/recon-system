// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpaceFolders } from "./space-folders";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });
async function mount(el: ReturnType<typeof h>) {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(el));
}
const LIST = { root: "/data/inbox/msi", folders: [{ name: "act" }, { name: "bal" }] };
const select = () => document.querySelector<HTMLSelectElement>('select[aria-label="Space folder"]');

describe("SpaceFolders", () => {
  it("picking a folder of the space fills Folder with its absolute path", async () => {
    const onPick = vi.fn();
    await mount(h(SpaceFolders, { list: LIST, path: "", onPick }));
    expect([...select()!.options].map((o) => o.textContent)).toEqual(["Choose a folder", "act/", "bal/"]);
    await act(async () => { select()!.value = "act"; select()!.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(onPick).toHaveBeenCalledWith("/data/inbox/msi/act");
  });

  it("shows the folder the path already names", async () => {
    await mount(h(SpaceFolders, { list: LIST, path: "/data/inbox/msi/bal", onPick: () => {} }));
    expect(select()!.value).toBe("bal");
  });

  it("is absent without folders (none yet, the inbox not set up, or the list failed): Folder works as before", async () => {
    await mount(h(SpaceFolders, { list: undefined, path: "", onPick: () => {} }));
    expect(select()).toBeNull();
    await act(async () => root!.render(h(SpaceFolders, { list: { root: "/data/inbox/msi", folders: [] }, path: "", onPick: () => {} })));
    expect(select()).toBeNull();
  });
});
