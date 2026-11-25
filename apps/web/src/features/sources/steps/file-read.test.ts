// @vitest-environment happy-dom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DetectDto, FileFormat } from "@starterkit/shared/contracts/sources";
import { FileRead } from "./file-read";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.innerHTML = ""; });
async function mount(props: Record<string, unknown>) {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(h(FileRead, { busy: false, error: null, canChange: true, onChange: () => {}, onPickFile: () => {}, ...props } as never)));
}
const FORMAT: FileFormat = { kind: "delimited", delimiter: "|", quote: '"', header: false, encoding: "utf-8", skip_bottom: 1 };
const result = (o: Partial<Extract<DetectDto, { supported: true }>> = {}): DetectDto => ({
  supported: true, sampleId: "s", fileName: "act20261125.txt", format: FORMAT, columns: ["col_01", "col_02"], confidence: "high", notes: [],
  rows: [{ line: 1, role: "detail", cells: ["A1", "B1"] }, { line: 2, role: "trailer", cells: ["T", "2"] }], ...o,
});
const text = () => document.body.textContent ?? "";

describe("FileRead", () => {
  it("a confident read folds into its summary, with the rows and their roles; Change opens the settings", async () => {
    await mount({ result: result(), format: FORMAT });
    expect(text()).toContain("act20261125.txt · Delimited · Pipe | · UTF-8 · No header · 1 row skipped at the end");
    expect([...document.querySelectorAll("td[data-role]")].map((x) => x.textContent)).toEqual(["Row", "Trailer"]);
    expect(document.querySelector('[role="radiogroup"][aria-label="File kind"]')).toBeNull();
    await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Change how the file is read"]')!.click());
    expect(document.querySelector('[role="radiogroup"][aria-label="File kind"]')).not.toBeNull();
  });

  it("a close call opens the settings with a notice; no rule at all says so", async () => {
    await mount({ result: result({ confidence: "low", notes: ["Check these settings: the file was hard to read."] }), format: FORMAT });
    expect(text()).toContain("Check these settings: the file was hard to read.");
    expect(document.querySelector('[role="radiogroup"][aria-label="File kind"]')).not.toBeNull();
    await act(async () => root!.render(h(FileRead, { busy: false, error: null, canChange: true, onChange: () => {}, onPickFile: () => {}, format: FORMAT,
      result: result({ confidence: "none", notes: ["This file can't be read automatically yet. Set how it is read below."] }) } as never)));
    expect(text()).toContain("This file can't be read automatically yet. Set how it is read below.");
  });

  it("a type it can't read says which and what to ask for", async () => {
    await mount({ result: { supported: false, fileName: "x.pdf", type: "PDF", reason: "PDF files aren't supported yet. Ask the sender for CSV, TXT or Excel." }, format: FORMAT });
    expect(text()).toContain("PDF files aren't supported yet. Ask the sender for CSV, TXT or Excel.");
  });

  it("someone who doesn't set how sources are read sees the summary without Change", async () => {
    await mount({ result: result(), format: FORMAT, canChange: false });
    expect(document.querySelector('button[aria-label="Change how the file is read"]')).toBeNull();
  });

  it("changing the kind hands the new format up", async () => {
    const onChange = vi.fn();
    await mount({ result: result({ confidence: "low" }), format: FORMAT, onChange });
    await act(async () => [...document.querySelectorAll<HTMLButtonElement>('[aria-label="File kind"] [role="radio"]')].find((b) => b.textContent === "Excel")!.click());
    expect(onChange).toHaveBeenCalledWith({ kind: "excel", sheet: { kind: "first" }, header: false, skip_bottom: 1 }); // skips carry over
  });
});
