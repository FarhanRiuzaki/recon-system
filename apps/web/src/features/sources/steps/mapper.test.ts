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
vi.mock("../use-spec-preview", () => ({ useSpecPreview: () => ({ result: null, error: null, pending: false }), previewBody: () => ({}) }));
const { SourceMapper } = await import("./mapper");

const f = (name: string) => ({ name, type: "string" as const, nullable: true, trim: true });
const spec = (fields = [f("sid"), f("sre")]): SourceSpec => ({
  fields, mapping: { business_date: { cel: "file_date" }, account_ref: { field: "sid" }, attrs: { sre: { field: "sre" } } }, derive: {}, key_fields: ["sid"], mutable: false, calendar: "id-default",
  input: { kind: "file_inbox", path: "/x", pattern: "*", completion: { kind: "stable_seconds", seconds: 60 }, format: { kind: "delimited", delimiter: "|", quote: '"', header: false, encoding: "utf-8" } },
} as SourceSpec);
let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });
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
});
