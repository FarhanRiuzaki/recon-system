import { createElement as h, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LibraryRowDto } from "@starterkit/shared/contracts/workflows";
import { DEFAULT_LEVELS } from "@starterkit/shared/workflows";
import { DEFAULT_ROW_ID, defaultChainText, levelsText, libraryColumns, libraryRows } from "./library-page";

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
  it("the built-in chain's words come from DEFAULT_LEVELS", () => {
    expect(defaultChainText()).toBe("one of Reviewer or Space admin");
    expect(defaultChainText([{ name: "A", groups: [{ spaceRoles: ["reviewer"], globalRoles: [], users: [], need: { kind: "all" } }] }, ...DEFAULT_LEVELS]))
      .toBe("all of Reviewer, then one of Reviewer or Space admin");
  });
  it("the built-in row leads only when the space has workflows, so No workflows yet still shows", () => {
    const first = { q: "", page: 1, failed: false };
    expect(libraryRows([], first)).toEqual([]);
    expect(libraryRows([W], first).map((r) => r.id)).toEqual([DEFAULT_ROW_ID, "w1"]);
    expect(libraryRows([W], { ...first, q: "tre" }).map((r) => r.id)).toEqual(["w1"]);
    expect(libraryRows([W], { ...first, page: 2 }).map((r) => r.id)).toEqual(["w1"]);
  });
});
