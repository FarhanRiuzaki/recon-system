// @vitest-environment happy-dom
import { act, createElement as h, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type ComboOption, Combobox, filterOptions, nextEnabled } from "./combobox";
import { CommandCombobox } from "./combobox-command";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const OPTS: ComboOption[] = [
  { value: "jkt", label: "Jakarta" }, { value: "bdg", label: "Bandung" }, { value: "sby", label: "Surabaya" },
  { value: "yog", label: "Yogyakarta", disabled: true }, { value: "mdn", label: "Medan" },
];

describe("filterOptions / nextEnabled", () => {
  it("matches anywhere in the label, those that start with the text first", () => {
    expect(filterOptions(OPTS, "a").slice(0, 1).map((o) => o.value)).toEqual(["jkt"]);
    expect(filterOptions(OPTS, "dung").map((o) => o.value)).toEqual(["bdg"]);
    expect(filterOptions(OPTS, "  ").length).toBe(5);
  });
  it("skips disabled options and wraps", () => {
    expect(nextEnabled(OPTS, 2, 1)).toBe(4);
    expect(nextEnabled(OPTS, 4, 1)).toBe(0);
    expect(nextEnabled(OPTS, 0, -1)).toBe(4);
  });
});

let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });
async function mount(el: ReturnType<typeof h>) {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(el));
}
const input = () => document.querySelector<HTMLInputElement>('[role="combobox"]')!;
const options = () => [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent);
const type = (v: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), v);
  input().dispatchEvent(new Event("input", { bubbles: true }));
});
const key = (k: string) => act(async () => { input().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })); });

function Single({ onChange }: { onChange?: (v: ComboOption | null) => void }) {
  const [v, setV] = useState<ComboOption | null>(null);
  return h(Combobox, { label: "City", options: OPTS, value: v, onChange: (x: ComboOption | null) => { setV(x); onChange?.(x); } });
}
function Multi({ onCreate }: { onCreate?: (t: string) => ComboOption }) {
  const [v, setV] = useState<ComboOption[]>([]);
  return h(Combobox, { label: "Cities", multiple: true, options: OPTS, value: v, onChange: setV, onCreate });
}

describe("Combobox (single)", () => {
  it("typing filters; ↓ then Enter picks the active option and shows its label; the field is a combobox over a listbox", async () => {
    const onChange = vi.fn();
    await mount(h(Single, { onChange }));
    expect(input().getAttribute("aria-expanded")).toBe("false");
    await type("ba");
    expect(input().getAttribute("aria-expanded")).toBe("true");
    expect(options()).toEqual(["Bandung", "Surabaya"]);
    await key("ArrowDown");
    expect(input().getAttribute("aria-activedescendant")).toMatch(/-opt-1$/);
    await key("Enter");
    expect(onChange).toHaveBeenCalledWith({ value: "sby", label: "Surabaya" });
    expect(input().value).toBe("Surabaya");
    expect(document.querySelector('[role="listbox"]')!.hasAttribute("hidden")).toBe(true);
    expect(document.querySelector('[aria-label="Clear City"]')).not.toBeNull();
  });
  it("Esc closes the list; the result count is announced", async () => {
    await mount(h(Single));
    await type("a");
    expect(document.querySelector('[role="status"]')!.textContent).toBe("5 options"); // Jakarta, Bandung, Surabaya, Yogyakarta (disabled, still listed), Medan
    await key("Escape");
    expect(input().getAttribute("aria-expanded")).toBe("false");
  });
});

describe("Combobox option tone", () => {
  it("ok draws a green check; bad a red cross with its reason in Down ink, readable while disabled", async () => {
    const opts: ComboOption[] = [
      { value: "upd", label: "updated_at", tone: "ok" },
      { value: "note", label: "note", tone: "bad", disabled: true, description: "Can be empty" },
      { value: "plain", label: "plain", disabled: true },
    ];
    await mount(h(Combobox, { label: "Watermark", options: opts, value: null, onChange: () => {} }));
    await type("");
    await key("ArrowDown");
    const [ok, bad, plain] = [...document.querySelectorAll('[role="option"]')] as HTMLElement[];
    expect(ok!.querySelector("svg")!.getAttribute("class")).toContain("text-healthy-mark");
    expect(bad!.querySelector("svg")!.getAttribute("class")).toContain("text-down-mark");
    expect(bad!.className).not.toContain("opacity-50");
    expect(bad!.textContent).toContain("Can be empty");
    expect(bad!.innerHTML).toContain("text-down-ink");
    expect(plain!.className).toContain("opacity-50");
    expect(plain!.querySelector("svg")).toBeNull();
  });
});

describe("Combobox (multiple)", () => {
  it("picks become chips (and leave the list); Backspace on an empty field removes the last; each chip has a named remove button", async () => {
    await mount(h(Multi));
    await type("jak"); await key("Enter");
    await type("med"); await key("Enter");
    expect([...document.querySelectorAll('button[aria-label^="Remove"]')].map((b) => b.getAttribute("aria-label"))).toEqual(["Remove Jakarta", "Remove Medan"]);
    await type("");
    expect(options()).not.toContain("Jakarta");
    await key("Backspace");
    expect(document.querySelector('[aria-label="Remove Medan"]')).toBeNull();
  });
  it("onCreate offers the typed text when nothing has that label", async () => {
    await mount(h(Multi, { onCreate: (t: string) => ({ value: t.toLowerCase(), label: t }) }));
    await type("Bali");
    expect(options()).toContain("Create “Bali”");
    await key("Enter");
    expect(document.querySelector('[aria-label="Remove Bali"]')).not.toBeNull();
  });
  it("a chosen option with a slot is a CategoryChip inside the field; one without stays a plain chip", async () => {
    await mount(h(Combobox, { label: "Cities", multiple: true, options: OPTS, onChange: () => {}, value: [{ value: "jkt", label: "Jakarta", slot: 2 }, { value: "mdn", label: "Medan" }] }));
    const chip = (name: string) => document.querySelector(`[aria-label="Remove ${name}"]`)!.parentElement!;
    expect(chip("Jakarta").getAttribute("data-slot")).toBe("category-chip");
    expect(chip("Jakarta").className).toContain("bg-chart-2/10");
    expect(chip("Medan").getAttribute("data-slot")).toBeNull();
    expect(chip("Jakarta").parentElement).toBe(input().parentElement);
  });
});

describe("Combobox (server search)", () => {
  it("loads after the debounce with the typed query; a failure offers Try again", async () => {
    const load = vi.fn(async (q: string) => OPTS.filter((o) => o.label.toLowerCase().startsWith(q.toLowerCase())));
    function Remote() { const [v, setV] = useState<ComboOption | null>(null); return h(Combobox, { label: "City", loadOptions: load, value: v, onChange: setV }); }
    await mount(h(Remote));
    await type("su");
    await act(async () => { await new Promise((r) => setTimeout(r, 320)); });
    expect(load).toHaveBeenLastCalledWith("su", expect.any(AbortSignal));
    expect(options()).toEqual(["Surabaya"]);
    load.mockRejectedValueOnce(new Error("down"));
    await type("me");
    await act(async () => { await new Promise((r) => setTimeout(r, 320)); });
    expect(document.querySelector('[role="listbox"]')!.textContent).toContain("Couldn't load the options.");
  });
});

describe("CommandCombobox (server query mode, REC-F2a)", () => {
  const TABLES = [
    { value: "core.tx", label: "tx", group: "core", description: "table · 18 columns", mono: true },
    { value: "core.tx_v", label: "tx_v", group: "core", description: "view · 7 columns", mono: true },
    { value: "ops.log", label: "log", group: "ops", description: "table · 3 columns", mono: true },
  ];
  async function openWith(props: Record<string, unknown>) {
    await mount(h(CommandCombobox, { label: "Table", options: [], value: [], onValueChange: () => {}, query: "", onQuery: () => {}, phone: "sheet", ...props }));
    const trigger = document.querySelector<HTMLButtonElement>('button[aria-label^="Table:"]')!;
    await act(async () => { trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); trigger.click(); });
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
    return trigger;
  }

  it("loading: three hidden skeleton rows and a status for screen readers", async () => {
    await openWith({ loading: true, loadingText: "Loading tables…" });
    expect(document.querySelector('[role="status"]')!.textContent).toBe("Loading tables…");
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBe(6);
  });

  it("options grouped under their heading, each with its second line; footer below the list, live count", async () => {
    const pick = vi.fn();
    await openWith({ options: TABLES, onValueChange: pick, footer: "Showing 3 of 1,284 tables. Type to narrow the list.", status: "3 of 1,284 tables shown" });
    expect([...document.querySelectorAll("[cmdk-group-heading]")].map((g) => g.textContent)).toEqual(["core", "ops"]);
    expect(options()).toEqual(["txtable · 18 columns", "tx_vview · 7 columns", "logtable · 3 columns"]);
    expect(document.querySelector('[cmdk-root]')!.textContent).toContain("Showing 3 of 1,284 tables. Type to narrow the list.");
    expect(document.querySelector('[aria-live="polite"]')!.textContent).toBe("3 of 1,284 tables shown");
    await act(async () => { (document.querySelectorAll('[role="option"]')[2] as HTMLElement).click(); });
    expect(pick).toHaveBeenCalledWith(["ops.log"]);
  });

  it("empty: the caller's sentence; failed: the message with Retry, which can wait", async () => {
    await openWith({ emptyText: "This account can't read any tables in core. Ask IT to grant SELECT." });
    expect(document.querySelector("[cmdk-empty]")!.textContent).toBe("This account can't read any tables in core. Ask IT to grant SELECT.");
    await act(async () => root?.unmount()); root = null; document.body.innerHTML = "";
    const retry = vi.fn();
    await openWith({ error: "The table list couldn't be loaded. The host could not be reached.", onRetry: retry, retryDisabled: true });
    const alert = document.querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain("The table list couldn't be loaded.");
    const button = alert.querySelector("button")!;
    expect(button.disabled).toBe(true);
  });

  it("opens on the search field, also as a phone sheet; Enter elsewhere (Cancel) picks nothing", async () => {
    const pick = vi.fn();
    await openWith({ options: TABLES, onValueChange: pick });
    const searchField = document.querySelector<HTMLInputElement>("[cmdk-input]")!;
    expect(document.activeElement).toBe(searchField);
    const cancel = [...document.querySelectorAll("button")].find((b) => b.textContent === "Cancel")!;
    cancel.focus();
    await act(async () => { cancel.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
    expect(pick).not.toHaveBeenCalled();
    expect(document.querySelector("[cmdk-list]")).toBeNull(); // Enter on Cancel closed the sheet
  });

  it("a value not among the options (picked before, gone after a retest) still shows on the trigger; disabled can't open", async () => {
    const trigger = await openWith({ value: ["core.gone"], disabled: true });
    expect(trigger.getAttribute("aria-label")).toBe("Table: core.gone");
    expect(trigger.disabled).toBe(true);
    expect(document.querySelector("[cmdk-list]")).toBeNull();
  });
});
