import { createElement as h, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { BreakRowDto } from "@starterkit/shared/contracts/breaks";
import { breakColumns } from "./break-columns";

const COLS = breakColumns("sp-1");
const B = {
  id: "b1", businessDate: "2026-11-20", recon: { id: "r1", name: "BI-FAST" }, side: "a", source: "Core banking", ref: "REF-1", amountMinor: "1000", currency: "IDR",
  reason: "Amount differs", proposedRef: null, state: "pending_external", assignee: null, ageDays: 2,
  counterpartSide: "Bank statement", recheck: { kind: "until", date: "2026-11-21" },
} as unknown as BreakRowDto;
const cell = (key: string, r: BreakRowDto = B) => renderToStaticMarkup(h(Fragment, null, COLS.find((c) => c.key === key)!.cell(r)));

describe("unmatch queue columns: the reason a category chip, the state a status chip (owner 24 Nov)", () => {
  it("a reason chip in its slot, a dash without one; the state as a chip, never plain text", () => {
    expect(cell("reason")).toContain('data-slot="category-chip"');
    expect(cell("reason")).toContain("bg-cat-violet");
    expect(cell("reason", { ...B, reason: null })).not.toContain("category-chip");
    expect(cell("state")).toContain(">Pending external</span>");
    expect(cell("state")).toContain('data-status="progress"');
    // a new break is open work: blue, never the green of done (review 24 Nov)
    expect(cell("state", { ...B, state: "new" })).toContain('data-status="progress"');
    expect(cell("state", { ...B, state: "resolved" })).toContain('data-status="healthy"');
  });
});

describe("unmatch queue columns: the set of audit §5.1", () => {
  it("at most 7 shown at first beside the checkbox; counterpart side, checked until and recon start hidden", () => {
    const shown = breakColumns("sp-1", { has: () => false, toggle: () => {}, all: { checked: false, count: 0, toggle: () => {} } }).filter((c) => !c.defaultHidden && c.key !== "select");
    expect(shown.map((c) => c.key)).toEqual(["break", "businessDate", "amount", "reason", "proposed", "state", "assignee"]);
    expect(COLS.filter((c) => c.defaultHidden).map((c) => c.key)).toEqual(["counterpartSide", "recheck", "recon"]);
    expect(COLS.filter((c) => c.sortable).map((c) => c.key)).toEqual(["businessDate", "amount", "state"]);
  });
  it("a proposed pair is a chip with its reference; checked until in words", () => {
    expect(cell("proposed", { ...B, proposedRef: "REF-9" })).toContain('data-slot="category-chip"');
    expect(cell("recheck")).toContain("21 Nov");
    expect(cell("recheck", { ...B, recheck: { kind: "always" } })).toBe("Every run");
  });
});

describe("unmatch queue columns: an item runs no longer check carries a neutral Not checked again chip", () => {
  it("every cell of a row stays within two lines (rows 52 px at most): the reference cut on one line, a name unwrapped", () => {
    expect(COLS.find((c) => c.key === "assignee")!.className).toContain("whitespace-nowrap");
    expect(COLS.find((c) => c.key === "break")!.className).toContain("[&_.truncate]:whitespace-nowrap");
  });
  it("in the Checked until column only: the State cell is one chip (review 24 Nov: rows 52 px at most)", () => {
    const no = { ...B, recheck: { kind: "no" } } as BreakRowDto;
    // checked until 21 Nov, the row 2 days old on 20 Nov: today is 22 Nov, so no longer checked (its last day stays in Checked until)
    const past = { ...B, businessDate: "2026-11-20", ageDays: 2 } as BreakRowDto;
    for (const r of [no, past]) {
      expect(cell("state", r)).not.toContain("Not checked again");
      expect(cell("state", r).match(/data-slot="(status|category)-chip"/g)).toHaveLength(1);
      expect(cell("recheck", r)).toContain(">Not checked again</span>");
      expect(cell("recheck", r)).toContain("bg-fg-4");
    }
    expect(cell("recheck", past)).toContain("21 Nov");
    const live = { ...B, ageDays: 1 } as BreakRowDto;
    expect(cell("recheck", live)).not.toContain("Not checked again");
    expect(cell("recheck", live)).toContain("21 Nov");
  });
  it("an item a request holds says so instead, in the Checked until column", () => {
    const held = { ...B, state: "pending_approval", recheck: { kind: "no" } } as BreakRowDto;
    expect(cell("recheck", held)).toContain(">Held by a request</span>");
    expect(cell("recheck", held)).not.toContain("Not checked again");
    expect(cell("state", held)).not.toContain("Held by a request");
  });
});
