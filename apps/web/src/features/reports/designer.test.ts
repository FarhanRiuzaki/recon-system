import { DndContext } from "@dnd-kit/core";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { columnFor, emptySpec } from "@starterkit/shared/report-spec";
import { TooltipProvider } from "@starterkit/ui/ui/tooltip";
import { dataOnly } from "./spec-model";
import { ReportCanvas } from "./report-canvas";
import type { Preview } from "./use-reports";

const spec = { ...emptySpec(), columns: [columnFor("c1", "a:ext_ref", "Reference"), columnFor("c2", "a:attrs.gone", "Gone")] };
const preview: Preview = {
  columns: [{ id: "c1", header: "Reference" }, { id: "c2", header: "Gone" }], lines: [{ kind: "row", cells: ["KS-1", ""], marks: [null, null] }],
  sheet: { title: "Breaks", header: null, footer: null, columnHeaders: true }, text: null, problems: [{ columnId: "c2", message: "Gone: Field not in the data." }], rows: 1,
};
const fields = new Map([["a:ext_ref", { ref: "a:ext_ref", label: "Reference", type: "text" as const, customer: false }]]);
const html = (s = spec) => renderToStaticMarkup(
  <TooltipProvider><DndContext><ReportCanvas spec={s} change={() => undefined} readOnly={false} preview={{ data: preview, error: null, loading: false }} date="2026-11-25" fields={fields}
    selected={{ kind: "column", id: "c1" }} select={() => undefined} drop={null} dragging={null} onAddField={() => undefined} /></DndContext></TooltipProvider>);

describe("the designer's canvas", () => {
  it("the file's sections as pressed chips; Data only offered; the rows of the preview date", () => {
    const out = html();
    expect(out).toMatch(/aria-pressed="true"[^>]*>.*Column headers/);
    expect(out).toContain("Data only");
    expect(out).toContain("1 row on 2026-11-25 in the preview");
    expect(out).toContain("KS-1");
  });
  it("data only: every chip off, the header row struck through and said so", () => {
    const out = html(dataOnly(spec));
    expect(out).not.toMatch(/aria-pressed="true"[^>]*>[^<]*<?[^>]*>?Title/);
    expect(out).toContain("Column headers are off");
  });
  it("a column on a field the data lacks says so on its header; a column can be added at the end", () => {
    const out = html();
    expect(out).toContain("Field not in the data.");
    expect(out).toContain("+ Add a column");
    expect(out).toContain('aria-pressed="true" aria-label="Column 1: Reference.');
  });
});
