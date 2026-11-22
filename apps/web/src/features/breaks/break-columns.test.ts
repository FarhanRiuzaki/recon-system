import { createElement as h, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BreakRowDto } from "@starterkit/shared/contracts/breaks";
import { breakColumns } from "./break-columns";

const COLS = breakColumns("sp-1");
const B = {
  id: "b1", businessDate: "2026-11-20", recon: { id: "r1", name: "BI-FAST" }, side: "a", source: "Core banking", ref: "REF-1", amountMinor: "1000", currency: "IDR",
  reason: "Amount differs", proposedRef: null, state: "pending_external", assignee: null, ageDays: 2,
} as unknown as BreakRowDto;
const cell = (key: string, r: BreakRowDto = B) => renderToStaticMarkup(h(Fragment, null, COLS.find((c) => c.key === key)!.cell(r)));

describe("unmatch queue columns: reason and state are chips from the chip map (audit §1.1)", () => {
  it("a reason chip in its slot, a dash without one; the state as a chip, never plain text", () => {
    expect(cell("reason")).toContain('data-slot="category-chip"');
    expect(cell("reason")).toContain("bg-chart-2");
    expect(cell("reason", { ...B, reason: null })).not.toContain("category-chip");
    expect(cell("state")).toContain(">Pending external</span>");
    expect(cell("state")).toContain("bg-chart-5");
    expect(cell("state", { ...B, state: "new" })).toContain("bg-fg-4");
  });
});
