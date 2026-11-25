// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpaceFolders, suggestPattern } from "./space-folders";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });
async function mount(el: ReturnType<typeof h>) {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(el));
}
const LIST = { root: "/data/inbox/msi", folders: [
  { name: "act", files: 3, newest: "act20261125.txt" },
  { name: "bal", files: 0, newest: null },
] };
const options = () => [...document.querySelectorAll<HTMLButtonElement>('[role="radiogroup"][aria-label="Space folders"] button')];

describe("suggestPattern", () => {
  it("turns the date or number in the newest file's name into *, keeping the rest", () => {
    expect(suggestPattern("act20261125.txt")).toBe("act*.txt");
    expect(suggestPattern("BAL_2026-11-25.csv")).toBe("BAL_*.csv");
    expect(suggestPattern("KOFIS-ACT-001.TXT")).toBe("KOFIS-ACT-*.TXT");
    expect(suggestPattern("settlement.csv")).toBe("*.csv");
    expect(suggestPattern("README")).toBe("*");
  });
});

describe("SpaceFolders", () => {
  it("lists the space's folders with their files, newest first; picking one answers its path and a pattern from its newest file", async () => {
    const onPick = vi.fn();
    await mount(h(SpaceFolders, { list: LIST, path: "", onPick }));
    expect(options().map((b) => b.textContent)).toEqual(["act/3 files · newest act20261125.txt", "bal/No files yet"]);
    await act(async () => options()[0]!.click());
    expect(onPick).toHaveBeenCalledWith("/data/inbox/msi/act", "act*.txt");
    await act(async () => options()[1]!.click());
    expect(onPick).toHaveBeenLastCalledWith("/data/inbox/msi/bal", null);
  });

  it("marks the folder the path already names", async () => {
    await mount(h(SpaceFolders, { list: LIST, path: "/data/inbox/msi/bal/", onPick: () => {} }));
    expect(options().map((b) => b.getAttribute("aria-checked"))).toEqual(["false", "true"]);
  });

  it("is absent without folders (none yet, the inbox not set up, or the list failed)", async () => {
    await mount(h(SpaceFolders, { list: undefined, path: "", onPick: () => {} }));
    expect(options()).toEqual([]);
    await act(async () => root!.render(h(SpaceFolders, { list: { root: "/data/inbox/msi", folders: [] }, path: "", onPick: () => {} })));
    expect(options()).toEqual([]);
  });
});
