// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionsIcon } from "../ui/icons";
import { columnChoice, DataTable, hiddenColumns } from "./data-table";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type S = { id: string };
let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });
async function mount(props: Record<string, unknown>) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(h(DataTable<S>, {
    label: "People", rows: [{ id: "a" }], rowKey: (r: S) => r.id,
    columns: [{ key: "name", header: "Name", sortable: true, cell: (r: S) => r.id }, { key: "at", header: "Created", sortable: true, cell: (r: S) => r.id }],
    empty: { icon: SessionsIcon, title: "No people", description: "None yet." }, ...props,
  })));
}
const change = (el: HTMLSelectElement, value: string) => act(async () => {
  el.value = value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
});

describe("DataTable on a phone: the sort select and the compact pagination are requests, as the headers and numbers are", () => {
  it("picking a sort calls onSortChange with the key and direction", async () => {
    const onSortChange = vi.fn();
    await mount({ sort: { key: "name", dir: "asc" }, onSortChange });
    await change(document.querySelector<HTMLSelectElement>('select[id]:not([aria-label="Rows per page"])')!, "at:desc");
    expect(onSortChange).toHaveBeenCalledWith({ key: "at", dir: "desc" });
  });

  it("compact pagination: Previous / 'Page x of y' / Next ask for the page next to it, the size select stays", async () => {
    const onPageChange = vi.fn();
    const onPageSizeChange = vi.fn();
    await mount({ paging: { mode: "server", page: 2, pageSize: 15, total: 40, pageSizes: [15, 25], maxPage: 1000, onPageChange, onPageSizeChange } });
    const nav = document.querySelector('nav[aria-label="People pages"]')!;
    const compact = [...nav.querySelectorAll("span")].find((s) => s.textContent === "Page 2 of 3")!;
    expect(compact.className.split(" ")).toContain("md:hidden");
    // The full pager's extra controls are desktop and tablet only.
    for (const l of ["First page", "Last page", "Page 1", "Page 3"]) expect(nav.querySelector(`[aria-label="${l}"]`)!.className.split(" ")).toContain("max-md:hidden");
    for (const l of ["Previous page", "Next page"]) expect(nav.querySelector(`[aria-label="${l}"]`)!.className.split(" ")).not.toContain("max-md:hidden");
    await act(async () => nav.querySelector<HTMLButtonElement>('[aria-label="Next page"]')!.click());
    expect(onPageChange).toHaveBeenLastCalledWith(3);
    await act(async () => nav.querySelector<HTMLButtonElement>('[aria-label="Previous page"]')!.click());
    expect(onPageChange).toHaveBeenLastCalledWith(1);
    await change(nav.querySelector<HTMLSelectElement>('[aria-label="Rows per page"]')!, "25");
    expect(onPageSizeChange).toHaveBeenCalledWith(25);
  });
});

describe("DataTable hidden columns (ColumnsMenu)", () => {
  const headers = () => [...document.querySelectorAll("thead th")].map((th) => th.textContent);
  it("drops a hidden column from the header and the rows; the identity (mobile title) column can't be hidden", async () => {
    await mount({ hidden: { shown: [], hidden: ["at", "name"] } });
    expect(headers()).toEqual(["Name"]);
    expect(document.querySelectorAll("tbody tr:first-child td")).toHaveLength(1);
  });
  it("defaultHidden: off until the viewer shows it; showing it keeps it on", async () => {
    const columns = [{ key: "name", header: "Name", cell: (r: S) => r.id }, { key: "at", header: "Created", defaultHidden: true, cell: (r: S) => r.id }];
    await mount({ columns });
    expect(headers()).toEqual(["Name"]);
    await act(async () => root?.unmount()); document.body.innerHTML = "";
    await mount({ columns, hidden: { shown: ["at"], hidden: [] } });
    expect(headers()).toEqual(["Name", "Created"]);
  });
  it("hiddenColumns: the defaults changed by the viewer's choice; a column added later as defaultHidden starts hidden despite a saved choice", () => {
    const columns = [{ key: "a", header: "A", cell: () => null }, { key: "b", header: "B", defaultHidden: true, cell: () => null }];
    expect(hiddenColumns(undefined, columns)).toEqual(["b"]);
    expect(hiddenColumns({ shown: [], hidden: [] }, columns)).toEqual(["b"]);
    expect(hiddenColumns({ shown: ["b"], hidden: [] }, columns)).toEqual([]);
    expect(hiddenColumns({ shown: [], hidden: ["a"] }, columns)).toEqual(["a", "b"]);
    const later = [...columns, { key: "created_at", header: "Created", defaultHidden: true, cell: () => null }];
    expect(hiddenColumns({ shown: ["b"], hidden: ["a"] }, later)).toEqual(["a", "created_at"]);
  });
  it("columnChoice: the hidden list as changes against the defaults; the defaults themselves are no choice (Reset)", () => {
    const columns = [{ key: "a", header: "A", cell: () => null }, { key: "b", header: "B", defaultHidden: true, cell: () => null }, { key: "c", header: "C", cell: () => null }];
    expect(columnChoice(["b"], columns)).toBeNull();
    expect(columnChoice([], columns)).toEqual({ shown: ["b"], hidden: [] });
    expect(columnChoice(["a", "b"], columns)).toEqual({ shown: [], hidden: ["a"] });
    // show / hide round trip
    const choice = columnChoice(["c"], columns)!;
    expect(hiddenColumns(choice, columns)).toEqual(["c"]);
    expect(columnChoice(hiddenColumns(choice, columns).filter((k) => k !== "c").concat("b"), columns)).toBeNull();
  });
  it("a column with hideable: false stays", async () => {
    await mount({ hidden: { shown: [], hidden: ["at"] }, columns: [{ key: "name", header: "Name", cell: (r: S) => r.id }, { key: "at", header: "Created", hideable: false, cell: (r: S) => r.id }] });
    expect(headers()).toEqual(["Name", "Created"]);
  });
});

describe("DataTable focus after a row goes away", () => {
  const withButtons = (ids: string[]) => ({
    rows: ids.map((id) => ({ id })),
    columns: [{ key: "name", header: "Name", cell: (r: S) => h("button", { type: "button" }, `Open ${r.id}`) }],
  });
  const button = (name: string) => [...document.querySelectorAll("button")].find((b) => b.textContent === name)!;
  it("focus in the removed row moves to the row that took its place, or the one before at the end", async () => {
    await mount(withButtons(["a", "b", "c"]));
    await act(async () => button("Open b").focus());
    await act(async () => root!.render(h(DataTable<S>, { label: "People", rowKey: (r: S) => r.id, empty: { icon: SessionsIcon, title: "No people", description: "None yet." }, ...withButtons(["a", "c"]) })));
    expect(document.activeElement?.textContent).toBe("Open c");
    await act(async () => button("Open c").focus());
    await act(async () => root!.render(h(DataTable<S>, { label: "People", rowKey: (r: S) => r.id, empty: { icon: SessionsIcon, title: "No people", description: "None yet." }, ...withButtons(["a"]) })));
    expect(document.activeElement?.textContent).toBe("Open a");
  });
  it("focus that moved elsewhere stays there", async () => {
    await mount(withButtons(["a", "b"]));
    const outside = document.createElement("button"); document.body.append(outside);
    await act(async () => button("Open b").focus());
    await act(async () => outside.focus());
    await act(async () => root!.render(h(DataTable<S>, { label: "People", rowKey: (r: S) => r.id, empty: { icon: SessionsIcon, title: "No people", description: "None yet." }, ...withButtons(["a"]) })));
    expect(document.activeElement).toBe(outside);
  });
});

describe("DataTable sticky columns and the scroll fades (owner 24 Nov: the fade sat over the sticky column)", () => {
  it("sets --table-stick to the sticky start columns' width and --table-stick-end to the row actions', so each fade begins past them", async () => {
    const w = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return (this as HTMLElement).tagName === "TH" ? 120 : 0; } });
    try {
      await mount({ rowActions: () => "x" });
      const frame = document.querySelector<HTMLElement>('[data-slot="table-frame"]')!;
      expect(frame.style.getPropertyValue("--table-stick")).toBe("120px");
      expect(frame.style.getPropertyValue("--table-stick-end")).toBe("120px");
    } finally {
      if (w) Object.defineProperty(HTMLElement.prototype, "offsetWidth", w);
    }
  });
});

describe("DataTable leading sticky columns (owner 24 Nov: Status, Side A and Side B stay while the table scrolls sideways)", () => {
  const three = [
    { key: "status", header: "Status", sticky: true, cell: (r: S) => r.id }, { key: "sa", header: "Side A", sticky: true, cell: (r: S) => r.id },
    { key: "sb", header: "Side B", sticky: true, cell: (r: S) => r.id }, { key: "ref", header: "Reference", cell: (r: S) => r.id },
  ];
  it("each sticky column starts where the one before ends, the hairline sits on the last only, and the fade starts past all three", async () => {
    const w = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, get() { return (this as HTMLElement).tagName === "TH" ? 100 : 0; } });
    try {
      await mount({ columns: three });
      const ths = [...document.querySelectorAll<HTMLElement>("thead th")];
      const left = (el: HTMLElement) => el.style.getPropertyValue("left");
      const table = document.querySelector<HTMLElement>("table")!;
      expect(["--stick-0", "--stick-1", "--stick-2"].map((v) => table.style.getPropertyValue(v))).toEqual(["0px", "100px", "200px"]);
      expect(ths.map(left)).toEqual(["var(--stick-0, 0px)", "var(--stick-1, 0px)", "var(--stick-2, 0px)", ""]);
      expect(ths.map((th) => th.className.includes("border-r-line"))).toEqual([false, false, true, false]);
      expect(ths.slice(0, 3).every((th) => th.className.includes("scroll:sticky"))).toBe(true);
      expect(ths[3]!.className).not.toContain("scroll:sticky");
      expect([...document.querySelectorAll<HTMLElement>("tbody tr:first-child td")].map(left)).toEqual(["var(--stick-0, 0px)", "var(--stick-1, 0px)", "var(--stick-2, 0px)", ""]);
      expect(document.querySelector<HTMLElement>('[data-slot="table-frame"]')!.style.getPropertyValue("--table-stick")).toBe("300px");
    } finally {
      if (w) Object.defineProperty(HTMLElement.prototype, "offsetWidth", w);
    }
  });
});

describe("DataTable align center", () => {
  it("centers the header and the cells of a centered column", async () => {
    await mount({ columns: [{ key: "name", header: "Name", cell: (r: S) => r.id }, { key: "st", header: "Status", align: "center", cell: (r: S) => r.id }] });
    expect(document.querySelectorAll("thead th")[1]!.className.split(" ")).toContain("text-center");
    expect(document.querySelectorAll("tbody td")[1]!.className.split(" ")).toContain("text-center");
  });
});
