// @vitest-environment happy-dom
import { act, createElement as h, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { SortableList } from "./sortable-list";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(() => { act(() => root?.unmount()); root = null; document.body.innerHTML = ""; });

const calls: string[][] = [];
function List({ start }: { start: string[] }) {
  const [items, setItems] = useState(start);
  return h(SortableList<string>, {
    items, getKey: (x) => x, noun: "Column", label: "Columns in order",
    onReorder: (next) => { calls.push(next); setItems(next); },
    renderItem: (x, row) => h("span", null, row.handle, `Column ${row.index + 1}: ${x}`),
  });
}
const mount = async (start: string[]) => {
  calls.length = 0;
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(h(List, { start })));
};
const press = async (key: string) => {
  const el = document.activeElement as HTMLElement;
  await act(async () => { el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })); });
};
const rows = () => [...document.querySelectorAll("li")].map((li) => li.textContent);
const said = () => document.querySelector('[data-slot="sortable-status"]')!.textContent;

describe("SortableList", () => {
  it("renders an ordered list with one handle per row, named by the row's number", () => {
    const html = renderToStaticMarkup(h(SortableList<string>, {
      items: ["a", "b"], noun: "Rule", label: "Rules, first match wins", onReorder: () => {}, renderItem: (x, r) => h("span", null, r.handle, x),
    }));
    expect(html).toMatch(/^<div[^>]*><ol aria-label="Rules, first match wins"/);
    expect(html.match(/aria-label="Move rule \d"/g)).toEqual(['aria-label="Move rule 1"', 'aria-label="Move rule 2"']);
  });

  it("no handle when disabled", () => {
    const html = renderToStaticMarkup(h(SortableList<string>, { items: ["a"], noun: "Rule", label: "Rules", disabled: true, onReorder: () => {}, renderItem: (x, r) => h("span", null, r.handle, x) }));
    expect(html).not.toContain("Move rule");
  });

  it("keyboard: Space picks the row up, arrows move it, Space drops it; onReorder gets the new order and focus stays on the handle", async () => {
    await mount(["a", "b", "c", "d"]);
    (document.querySelector('[aria-label="Move column 1"]') as HTMLElement).focus();
    await press(" ");
    expect(said()).toBe("Column 1 picked up, position 1 of 4.");
    await press("ArrowDown");
    await press("ArrowDown");
    expect(said()).toBe("Column 1 moved to position 3 of 4.");
    await press(" ");
    expect(said()).toBe("Column 1 dropped at position 3 of 4.");
    expect(calls.at(-1)).toEqual(["b", "c", "a", "d"]);
    expect(rows()).toEqual(["Column 1: b", "Column 2: c", "Column 3: a", "Column 4: d"]);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Move column 3");
  });

  it("keyboard: Escape puts the row back where it was picked up", async () => {
    await mount(["a", "b", "c"]);
    (document.querySelector('[aria-label="Move column 3"]') as HTMLElement).focus();
    await press("Enter");
    await press("ArrowUp");
    await press("Escape");
    expect(calls.at(-1)).toEqual(["a", "b", "c"]);
    expect(said()).toBe("Move cancelled. Column 3 is back at position 3 of 3.");
  });
});
