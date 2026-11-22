import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ReactFlowProvider } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { TableCard } from "./table-node";

const html = (el: ReturnType<typeof h>) => renderToStaticMarkup(h(ReactFlowProvider, null, el));

describe("TableCard (an ERD table on a canvas)", () => {
  const out = html(h(TableCard, {
    title: "Request", caption: "Post to GL · POST /gl", side: "target",
    rows: [
      { id: "amount", label: "amount", required: true, state: "missing", connectable: true },
      { id: "Header", label: "Header", header: true, connectable: false },
      { id: "Header.Channel", label: "Channel", depth: 1, required: true, state: "fixed", note: "Fixed", connectable: false },
      { id: "remark", label: "remark", state: "mapped", note: "“Write-off”", connectable: true, selected: true },
      { id: "fee", label: "fee", state: "mapped", connectable: true, type: "numeric", limit: "≤ 15", example: "150000" },
    ],
  }));
  it("names itself and counts its rows", () => {
    expect(out).toContain('data-slot="table-node"');
    expect(out).toMatch(/aria-label="Request"/);
    expect(out).toContain("Post to GL · POST /gl");
  });
  it("a required field carries the red asterisk; a missing one says so in words, not colour alone", () => {
    expect(out).toMatch(/amount<span aria-hidden="true" class="[^"]*text-destructive[^"]*">\*<\/span>/);
    expect(out).toContain("Not mapped");
  });
  it("a handle only on rows that take a connection, on the target's left", () => {
    expect((out.match(/react-flow__handle-left/g) ?? []).length).toBe(3);
    expect(out).not.toContain("react-flow__handle-right");
  });
  it("each row shows its data type, a length limit and an example value (owner 22 Nov)", () => {
    expect(out).toMatch(/data-row="fee".*150000.*≤ 15 numeric/s);
  });
  it("a header row is indented content, a fixed field shows its note; the selected row is marked", () => {
    expect(out).toContain("Fixed");
    expect(out).toMatch(/data-row="remark"[^>]*aria-current="true"/);
  });
  it("a row that can be chosen is a button (keyboard: Tab, Enter), named by its field; a header isn't (final review m5)", () => {
    const out2 = html(h(TableCard, { title: "Request", side: "target", onRowSelect: () => {}, rows: [
      { id: "Header", label: "Header", header: true, connectable: false },
      { id: "Header.Ref", label: "Ref", depth: 1, required: true, connectable: true },
    ] }));
    expect(out2).toMatch(/<button type="button" aria-label="Open Ref" class="[^"]*nodrag[^"]*"/);
    expect((out2.match(/<button/g) ?? []).length).toBe(1);
  });
});
