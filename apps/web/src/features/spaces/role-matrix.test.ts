import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ROLE_LABEL, SPACE_ROLES } from "@starterkit/shared/spaces";
import { ROLE_MATRIX, RoleMatrix } from "./role-matrix";

const rows = ROLE_MATRIX.flatMap((g) => g.rows);
const row = (action: string) => rows.find((r) => r.action === action)!.cells;

describe("RoleMatrix (Figma 01 Space & shell, RoleMatrix: 7 roles × 16 actions)", () => {
  it("16 actions in three groups, a cell per role", () => {
    expect(ROLE_MATRIX.map((g) => [g.group, g.rows.length])).toEqual([["Daily work", 11], ["Configuration", 4], ["Space", 1]]);
    for (const r of rows) expect(r.cells, r.action).toHaveLength(SPACE_ROLES.length);
  });
  it("cells as designed: makers do, checkers approve, the source admin only on sources", () => {
    expect(row("Force match outside tolerance")).toEqual(["none", "none", "none", "none", "does", "approves", "none"]);
    expect(row("Write off, above the reviewer limit")).toEqual(["approves", "none", "none", "none", "does", "none", "none"]);
    expect(row("Declare source fields and mapping (source version)")).toEqual(["none", "does", "does", "approves", "none", "none", "none"]);
    expect(row("View recons, live day, unmatch and explanations")).toEqual(["views", "none", "views", "views", "views", "views", "views"]);
    expect(row("Prepare a day for sign-off")).toEqual(["none", "none", "none", "none", "none", "does", "none"]);
    expect(row("Approve a day's sign-off")).toEqual(["approves", "none", "none", "none", "none", "approves", "none"]);
    expect(rows.some((r) => r.action === "Sign off a business day")).toBe(false);
    expect(row("Add and remove members, change their roles")).toEqual(["does", "none", "none", "none", "none", "none", "none"]);
  });
  it("renders a table with the roles as columns; a dash cell says Not allowed to a screen reader; the source admin footnote", () => {
    const html = renderToStaticMarkup(h(RoleMatrix));
    expect([...html.matchAll(/<th scope="col"[^>]*>([^<]+)</g)].map((m) => m[1])).toEqual(["Action", ...SPACE_ROLES.map((r) => ROLE_LABEL[r])]);
    expect([...html.matchAll(/<th scope="row"/g)]).toHaveLength(16);
    const none = rows.flatMap((r) => r.cells).filter((c) => c === "none").length;
    expect(html.match(/<span class="sr-only">Not allowed<\/span>/g)).toHaveLength(none);
    expect(html).not.toMatch(/text-fg-4/);
    expect(html).toContain("Source admin is granted and removed only by an app admin, not by a space admin.");
    expect(html).toContain("The approver can&#x27;t be the preparer or anyone who resolved an item that day. Approving freezes the day.");
  });
});
