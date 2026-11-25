// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ctl, type Draft, EMPTY_CONN, emptySpec } from "./model";
import { FieldsStep, type FieldsStepProps } from "./fields";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@/lib/client/api", () => ({ api: vi.fn(), errorText: String, ApiError: class extends Error {} }));
let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });

const spec = emptySpec("file_inbox");
const d: Draft = { name: "KOFIS ACT", code: "kofis", kind: "file_inbox", conn: EMPTY_CONN, from: "table",
  spec: { ...spec, fields: [{ name: "sid", type: "string", nullable: true, trim: true }], mapping: { ...spec.mapping, business_date: { cel: "file_date" }, account_ref: { field: "sid" } } } } as Draft;
const props = (err: (id: string) => string | undefined): FieldsStepProps => ({
  d, set: () => {}, err, engine: null, native: new Map(), canRead: false, reading: false, onReadColumns: () => {}, sample: "", fileName: "", sampleCut: false,
  onSample: () => {}, onFileName: () => {}, onReadSample: () => {}, businessDate: "", onBusinessDate: () => {}, preview: { result: null, error: null, pending: false },
  onPreview: null, columns: null, created: true, canChangeReading: true, headerHint: false, onUseHeader: () => {}, typedNames: {}, onTypedName: () => {},
  gone: { gone: [], used: [] }, suggested: null, coreHint: {}, mapperPreview: { spaceId: "sp", ids: null, sampleId: null },
} as unknown as FieldsStepProps);
async function mount(err: (id: string) => string | undefined = () => undefined) {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(h(FieldsStep, props(err))));
}
const list = () => [...document.querySelectorAll("details")].find((x) => x.querySelector("summary")?.textContent === "View as list")!;

describe("step 2 mapping", () => {
  it("shows the summary and Open mapper, with the tables under a closed View as list", async () => {
    await mount();
    expect(document.body.textContent).toContain("2 core fields mapped · 0 extra attributes");
    expect([...document.querySelectorAll("button")].some((b) => b.textContent === "Open mapper")).toBe(true);
    expect(list().open).toBe(false);
  });

  it("an error inside the tables opens View as list", async () => {
    await mount((id) => (id === ctl("mapping.business_date") ? "Pick the business date" : undefined));
    expect(list().open).toBe(true);
  });
});
