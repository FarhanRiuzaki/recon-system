// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDLE, STALE_NOTE, type TablesPage } from "./catalog";
import { NamePicker, TablePicker } from "./pickers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });
async function mount(el: ReturnType<typeof h>) {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(el));
}
async function open() {
  const t = document.querySelector<HTMLButtonElement>('button[aria-label^="Table:"], button[aria-label^="Database:"]')!;
  await act(async () => { t.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); t.click(); });
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
}
const note = () => document.querySelector('[id$="-note"]')?.textContent;

const page = (n: number, total: number, next: boolean): TablesPage => ({
  list: "tables", items: Array.from({ length: n }, (_, i) => ({ schema: "recon_core", name: `t${i}`, kind: "table", columns: 4 })), total, totalCapped: false,
  next: next ? { schema: "recon_core", name: `t${n - 1}` } : null,
});
const table = (over: Record<string, unknown>) => h(TablePicker, {
  id: "src-input-table", label: "Table", value: "", engine: "postgres", database: "recon_core", page: null, query: "", onQuery: () => {}, onChange: () => {}, onPick: () => {},
  columns: { reading: false, n: null }, list: IDLE, stale: false, free: false, onFree: () => {}, onRetry: () => {}, note: "table or schema.table", ...over,
});

describe("TablePicker states (designer's SPEC)", () => {
  it("before a test: the text field with its note; no way to a list yet", async () => {
    await mount(table({}));
    expect(document.querySelector("input#src-input-table")).not.toBeNull();
    expect(document.body.textContent).not.toContain("Type a name instead");
  });

  it("loading: skeleton rows and \"Loading tables…\"", async () => {
    await mount(table({ list: { status: "loading" } }));
    await open();
    expect(document.querySelector('[role="status"]')!.textContent).toBe("Loading tables…");
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it("empty: the account can't read any tables in the database, with the way out", async () => {
    const p = page(0, 0, false);
    await mount(table({ list: { status: "ready", data: p }, page: p }));
    await open();
    expect(document.querySelector("[cmdk-empty]")!.textContent).toBe("This account can't read any tables in recon_core. Ask IT to grant SELECT.");
    expect(document.querySelector("[cmdk-root]")!.textContent).toContain("Type a name instead");
  });

  it("failed: the API's sentence after what failed, with Retry", async () => {
    const retry = vi.fn();
    await mount(table({ list: { status: "error", message: "The host could not be reached (ECONNREFUSED). Check the host and port, and that this server may connect to it.", retryAt: null }, onRetry: retry }));
    await open();
    const alert = document.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("The table list couldn't be loaded. The host could not be reached (ECONNREFUSED).");
    await act(async () => alert.querySelector("button")!.click());
    expect(retry).toHaveBeenCalled();
  });

  it("truncated: how many of how many, and the live count; groups by schema", async () => {
    const p = page(50, 1284, true);
    await mount(table({ list: { status: "ready", data: p }, page: p }));
    await open();
    expect(document.querySelector("[cmdk-root]")!.textContent).toContain("Showing 50 of 1,284 tables. Type to narrow the list.");
    expect(document.querySelector('[aria-live="polite"]')!.textContent).toBe("50 of 1,284 tables shown");
    expect([...document.querySelectorAll("[cmdk-group-heading]")].map((x) => x.textContent)).toEqual(["recon_core"]);
  });

  it("stale after a connection change: the pick stays on a trigger that doesn't open, with the note", async () => {
    const p = page(2, 2, false);
    await mount(table({ list: { status: "ready", data: p }, page: p, value: "recon_core.t1", stale: true }));
    const t = document.querySelector<HTMLButtonElement>('button[aria-label^="Table:"]')!;
    expect([t.getAttribute("aria-label"), t.disabled]).toEqual(["Table: recon_core.t1", true]);
    expect(note()).toBe(STALE_NOTE);
  });

  it("a pick the list no longer has is kept and marked; reading columns, then how many", async () => {
    const p = page(2, 2, false);
    await mount(table({ list: { status: "ready", data: p }, page: p, value: "recon_core.gone" }));
    expect(note()).toBe("recon_core.gone isn't in the list for this account any more.");
    await act(async () => root!.render(table({ list: { status: "ready", data: p }, page: p, value: "recon_core.t1", columns: { reading: true, n: null } })));
    expect(note()).toBe("Reading columns…");
    await act(async () => root!.render(table({ list: { status: "ready", data: p }, page: p, value: "recon_core.t1", columns: { reading: false, n: 18 } })));
    expect(note()).toBe("18 columns read.");
  });
});

describe("NamePicker", () => {
  it("no database this login can open: says so; typed instead shows the text field and the way back", async () => {
    const onFree = vi.fn();
    await mount(h(NamePicker, { id: "src-database", label: "Database", noun: "database", value: "", names: { items: [], truncated: false }, list: { status: "ready", data: { items: [], truncated: false } },
      stale: false, free: false, onFree, onRetry: () => {}, onChange: () => {}, onPick: () => {} }));
    await open();
    expect(document.querySelector("[cmdk-empty]")!.textContent).toBe("This account can't open any database on this server. Ask IT to grant access.");
    await act(async () => root!.render(h(NamePicker, { id: "src-database", label: "Database", noun: "database", value: "core", names: null, list: { status: "ready", data: { items: [], truncated: false } },
      stale: false, free: true, onFree, onRetry: () => {}, onChange: () => {}, onPick: () => {} })));
    expect(document.querySelector("input#src-database")).not.toBeNull();
    const back = [...document.querySelectorAll("button")].find((b) => b.textContent === "Choose from the list")!;
    await act(async () => back.click());
    expect(onFree).toHaveBeenCalledWith(false);
  });
});
