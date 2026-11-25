// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourceSpec } from "@starterkit/shared/contracts/sources";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@/components/field-map/canvas", () => ({
  FieldMapCanvas: (p: { graph: { request: { path: string; name: string }[] }; onSelect: (x: string) => void }) =>
    h("div", { "data-testid": "canvas" }, p.graph.request.map((r) => h("button", { key: r.path, type: "button", onClick: () => p.onSelect(r.path) }, `row ${r.name}`))),
}));
const live = { field: null as { path: string; reason: string } | null };
vi.mock("../use-spec-preview", () => ({ useSpecPreview: () => ({ result: null, error: live.field ? "refused" : null, pending: false, field: live.field }), previewBody: () => ({}) }));
const { SourceMapper } = await import("./mapper");

const f = (name: string) => ({ name, type: "string" as const, nullable: true, trim: true });
const spec = (fields = [f("sid"), f("sre")]): SourceSpec => ({
  fields, mapping: { business_date: { cel: "file_date" }, account_ref: { field: "sid" }, attrs: { sre: { field: "sre" } } }, derive: {}, key_fields: ["sid"], mutable: false, calendar: "id-default",
  input: { kind: "file_inbox", path: "/x", pattern: "*", completion: { kind: "stable_seconds", seconds: 60 }, format: { kind: "delimited", delimiter: "|", quote: '"', header: false, encoding: "utf-8" } },
} as SourceSpec);
let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; live.field = null; });
async function mount(s: SourceSpec, onDone = vi.fn(), onCancel = vi.fn()) {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(h(SourceMapper, { open: true, name: "KOFIS ACT", spec: s, examples: {}, preview: { spaceId: "sp", ids: null, file: true, sampleId: null, sample: "", fileName: "", businessDate: "" }, onDone, onCancel })));
  return { onDone, onCancel };
}
const click = (text: string) => act(async () => [...document.querySelectorAll("button")].find((b) => b.textContent === text)!.click());
const pick = (label: string, value: string) => act(async () => { const s = document.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!; s.value = value; s.dispatchEvent(new Event("change", { bubbles: true })); });
const text = () => document.body.textContent ?? "";

describe("SourceMapper", () => {
  it("shows the source and its summary; mapping a core row in the inspector and Done hands the new spec up", async () => {
    const s = spec();
    const { onDone } = await mount(s);
    expect(text()).toContain("KOFIS ACT");
    expect(text()).toContain("2 core fields mapped · 1 extra attribute");
    await click("row Account");
    await pick("Account comes from", "field:sre");
    await click("Done");
    expect(onDone.mock.calls[0]![0].mapping.account_ref).toEqual({ field: "sre" });
  });

  it("Cancel after an edit leaves the spec it was given as it was", async () => {
    const s = spec();
    const before = structuredClone(s);
    const { onCancel } = await mount(s);
    await click("row Account");
    await pick("Account comes from", "field:sre");
    await click("Cancel");
    expect(onCancel).toHaveBeenCalled();
    expect(s).toEqual(before);
  });

  it("the business date can't be removed", async () => {
    await mount(spec());
    await click("row Business date");
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Remove the mapping of Business date"]')!.click());
    expect(text()).toContain("The business date is required. Map it to a column or a date preset.");
  });

  it("past 30 columns a search narrows the column list", async () => {
    await mount(spec(Array.from({ length: 31 }, (_, i) => f(`c${i}`))));
    const box = document.querySelector<HTMLInputElement>('input[aria-label="Search columns"]')!;
    expect(box).not.toBeNull();
    await act(async () => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; set.call(box, "c30"); box.dispatchEvent(new Event("input", { bubbles: true })); });
    expect([...document.querySelectorAll('[aria-label="Columns"] li')].map((x) => x.textContent?.split(" ")[0])).toEqual(["c30"]);
  });

  it("Escape after an edit asks instead of dropping the changes", async () => {
    const { onCancel } = await mount(spec());
    await click("row Account");
    await pick("Account comes from", "field:sre");
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(onCancel).not.toHaveBeenCalled();
    expect(text()).toContain("Use Cancel to drop your changes, or Done to keep them.");
  });

  describe("the rest of the inspector", () => {
    const amt = () => spec([f("sid"), f("sre"), { ...f("amt"), type: "decimal" } as unknown as ReturnType<typeof f>, f("data")]);
    const type = (label: string, value: string) => act(async () => { const el = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
    it("the amount asks for its unit, and the choice is kept", async () => {
      const { onDone } = await mount(amt());
      await click("row Amount");
      await pick("Amount comes from", "field:amt");
      expect(text()).toContain("Choose whether the amount is in currency units or minor units.");
      await pick("Amount unit", "minor");
      expect(text()).not.toContain("Choose whether the amount is in currency units or minor units.");
      await click("Done");
      expect(onDone.mock.calls[0]![0].mapping.amount_minor).toEqual({ field: "amt", unit: "minor" });
    });
    it("a JSON path and a formula from the inspector", async () => {
      const { onDone } = await mount(amt());
      await click("row Reference");
      await pick("Reference comes from", "json");
      await pick("JSON column", "data");
      await type("JSON path", "code.rc");
      await click("row Account");
      await pick("Account comes from", "cel");
      await type("Formula", "sid + sre");
      await act(async () => { document.querySelector<HTMLInputElement>('input[aria-label="Formula"]')!.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
      await click("Done");
      const m = onDone.mock.calls[0]![0].mapping;
      expect(m.ext_ref.cel).toContain("code.rc");
      expect(m.account_ref).toEqual({ cel: "sid + sre" });
    });
    it("a column's type, empty values and stored name", async () => {
      const { onDone } = await mount(amt());
      await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Edit column sre"]')!.click());
      await pick("Type of sre", "date");
      await type("Stored as", "1x");
      expect(text()).toContain("Use a-z, 0-9 and _, starting with a letter, up to 63 characters.");
      await type("Stored as", "sre_code");
      await click("Done");
      const s = onDone.mock.calls[0]![0];
      expect(s.fields[1]).toMatchObject({ name: "sre", type: "date" });
      expect(Object.keys(s.mapping.attrs)).toEqual(["sre_code"]);
    });
    it("the extra attributes row lists them, each removable", async () => {
      const { onDone } = await mount(spec());
      await click("row Extra attributes");
      expect(text()).toContain("sre");
      await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Stop keeping sre"]')!.click());
      await click("Done");
      expect(onDone.mock.calls[0]![0].mapping.attrs).toEqual({});
    });
  });

  describe("review of the inspector", () => {
    const type = (label: string, value: string) => act(async () => { const el = document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!; Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value); el.dispatchEvent(new Event("input", { bubbles: true })); });
    const blur = (label: string) => act(async () => { document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!.dispatchEvent(new FocusEvent("focusout", { bubbles: true })); });
    it("a formula is applied when the box is left, and an empty one removes the mapping", async () => {
      const { onDone } = await mount(spec());
      await click("row Account");
      await pick("Account comes from", "cel");
      await type("Formula", "sid + sre");
      await blur("Formula");
      await type("Formula", "");
      await blur("Formula");
      await click("Done");
      expect(onDone.mock.calls[0]![0].mapping.account_ref).toBeUndefined();
    });
    it("a JSON path that isn't keys with dots is not applied, and says why", async () => {
      const { onDone } = await mount(spec());
      await click("row Reference");
      await pick("Reference comes from", "json");
      await type("JSON path", "code.");
      expect(text()).toContain("Use keys joined by dots, like code.rc.");
      await click("Done");
      expect(onDone.mock.calls[0]![0].mapping.ext_ref).toBeUndefined();
    });
    it("choosing another row ends the formula being typed", async () => {
      await mount(spec());
      await click("row Account");
      await pick("Account comes from", "cel");
      await click("row Reference");
      await click("row Account");
      expect(document.querySelector<HTMLSelectElement>('select[aria-label="Account comes from"]')!.value).toBe("field:sid");
    });
  });

  describe("one place to map", () => {
    it("opens at the field a problem names", async () => {
      const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
      await act(async () => root!.render(h(SourceMapper, { open: true, name: "x", spec: spec(), examples: {}, initial: "col:sre", preview: { spaceId: "sp", ids: null, file: true, sampleId: null, sample: "", fileName: "", businessDate: "" }, onDone: vi.fn(), onCancel: vi.fn() })));
      expect(document.querySelector('select[aria-label="Type of sre"]')).not.toBeNull();
    });
    it("a date column's format is set in its inspector", async () => {
      const { onDone } = await mount(spec());
      await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Edit column sre"]')!.click());
      await pick("Type of sre", "date");
      const el = document.querySelector<HTMLInputElement>('input[aria-label="Date format of sre"]')!;
      await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, "ddMMyyyy"); el.dispatchEvent(new Event("input", { bubbles: true })); });
      await click("Done");
      expect(onDone.mock.calls[0]![0].fields[1].format).toEqual({ date: "ddMMyyyy" });
    });
    it("adds a computed column from the mapper", async () => {
      const { onDone } = await mount(spec());
      await click("Add computed column");
      await click("Done");
      expect(Object.keys(onDone.mock.calls[0]![0].derive)).toEqual(["computed_1"]);
    });
    it("names the source's columns for a file or a database alike", async () => {
      await mount(spec());
      expect(text()).not.toContain("Date and number formats are set in View as list.");
    });
  });

  it("a computed column in the mapper has its own ids, and a name a column has is refused", async () => {
    await mount(spec());
    await click("Add computed column");
    const name = document.getElementById("mapper-derive-computed_1-name") as HTMLInputElement;
    expect(name).not.toBeNull();
    expect(document.activeElement).toBe(name);
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "sid"); name.dispatchEvent(new Event("input", { bubbles: true })); });
    expect(text()).toContain("A column is already named sid. Use a different name.");
  });

  it("the preview's refusal of a computed column shows on its card", async () => {
    live.field = { path: "derive.net", reason: "unknown function" };
    await mount({ ...spec(), derive: { net: "nope(sid)" } } as SourceSpec);
    expect(text()).toContain("unknown function");
    expect(document.querySelector('[aria-label="Preview and computed columns"]')).not.toBeNull();
  });

  it("editing a computed card keeps the formula being typed in the inspector", async () => {
    await mount({ ...spec(), derive: { net: "sid" } } as SourceSpec);
    await click("row Account");
    await pick("Account comes from", "cel");
    const f = document.querySelector<HTMLInputElement>('input[aria-label="Formula"]')!;
    const set = (el: HTMLInputElement, v: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v); el.dispatchEvent(new Event("input", { bubbles: true })); });
    await set(f, "sid + sre");
    await set(document.getElementById("mapper-derive-net") as HTMLInputElement, "sre");
    expect(document.querySelector<HTMLInputElement>('input[aria-label="Formula"]')?.value).toBe("sid + sre");
  });
});
