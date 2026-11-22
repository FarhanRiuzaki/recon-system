import { createElement as h, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LibraryRowDto } from "@starterkit/shared/contracts/workflows";
import { DEFAULT_ROW_ID, levelsText, libraryColumns } from "./library-page";

const COLS = libraryColumns("sp-1");
const W: LibraryRowDto = { id: "w1", name: "Treasury head", levels: 2, levelNames: ["Review", "Head"], archived: false, published: { version: 3, decidedAt: null }, open: null, reconsUsing: 2, updatedAt: "2026-11-20T00:00:00Z" };
const cell = (key: string, r: LibraryRowDto = W) => renderToStaticMarkup(h(Fragment, null, COLS.find((c) => c.key === key)!.cell(r)));

describe("workflows list (audit §5.7)", () => {
  it("levels summary by name, else a count; live as a status chip; used by links to the workflow's used-by", () => {
    expect(levelsText(W)).toBe("Review · Head");
    expect(levelsText({ levels: 2, levelNames: ["Review", ""] })).toBe("2 levels");
    expect(cell("live")).toContain('data-status="healthy"');
    expect(cell("live", { ...W, published: null })).toContain("Not live");
    expect(cell("usedBy")).toContain('href="/spaces/sp-1/workflows/w1#used-by"');
    expect(cell("usedBy", { ...W, reconsUsing: 0 })).toContain("Not used");
  });
  it("the built-in default chain is read only: no link", () => {
    const d = { ...W, id: DEFAULT_ROW_ID, name: "Default chain", published: null, reconsUsing: 0, updatedAt: "" };
    expect(cell("name", d)).not.toContain("href");
    expect(cell("name", d)).toContain("read only");
    expect(cell("live", d)).toContain("Always");
  });
});
