import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ROLE_LABEL, SPACE_ROLES } from "@starterkit/shared/spaces";
import { ROLE_MATRIX, RoleMatrix } from "./role-matrix";

const rows = ROLE_MATRIX.flatMap((g) => g.rows);
const row = (action: string) => rows.find((r) => r.action === action)!.cells;

describe("RoleMatrix: 7 roles × the actions the API guards today (audit M2)", () => {
  it("the current actions in three groups, a cell per role", () => {
    expect(ROLE_MATRIX.map((g) => [g.group, g.rows.map((r) => r.action)])).toEqual([
      ["Daily work", ["View recons, today and unmatch items", "Take an item and set its state", "Assign items to someone", "Run a recon now", "Match", "Request posting", "Force match", "Write-off", "Close without a match", "Undo match", "Approve requests", "Sign off a day"]],
      ["Setup", ["Set up recons", "Set up sources", "Connect a source and pull it", "Set up workflows"]],
      ["Space", ["Manage members", "Share a source with another space"]],
    ]);
    for (const r of rows) expect(r.cells, r.action).toHaveLength(SPACE_ROLES.length);
  });
  it("cells as the API guards them: whoever works items does, the default chain approves, makers set up, checkers approve", () => {
    const worker = ["does", "none", "none", "none", "does", "does", "none"];
    for (const a of ["Match", "Request posting", "Force match", "Write-off", "Close without a match", "Undo match", "Take an item and set its state"]) expect(row(a), a).toEqual(worker);
    expect(row("Assign items to someone")).toEqual(["does", "none", "none", "none", "none", "does", "none"]);
    expect(row("Run a recon now")).toEqual(["does", "none", "does", "none", "does", "none", "none"]);
    expect(row("Approve requests")).toEqual(["approves", "none", "none", "none", "none", "approves", "none"]);
    expect(row("Sign off a day")).toEqual(["does", "none", "none", "none", "none", "does", "none"]);
    expect(row("Set up recons")).toEqual(["none", "none", "does", "approves", "none", "none", "none"]);
    expect(row("Set up sources")).toEqual(["none", "does", "does", "approves", "none", "none", "none"]);
    expect(row("View recons, today and unmatch items")).toEqual(Array(7).fill("views"));
    expect(row("Manage members")).toEqual(["does", "none", "none", "none", "none", "none", "none"]);
  });
  it("renders a table with the roles as columns; a dash cell says Not allowed to a screen reader; the source admin footnote", () => {
    const html = renderToStaticMarkup(h(RoleMatrix));
    expect([...html.matchAll(/<th scope="col"[^>]*>([^<]+)</g)].map((m) => m[1])).toEqual(["Action", ...SPACE_ROLES.map((r) => ROLE_LABEL[r])]);
    expect([...html.matchAll(/<th scope="row"/g)]).toHaveLength(rows.length);
    // 18rem Action column + 7 × 108 px fits the 1440 content width: no sideways scroll there (M2)
    expect(html).toContain("xl:w-72");
    expect(html).not.toContain("xl:min-w-274");
    const none = rows.flatMap((r) => r.cells).filter((c) => c === "none").length;
    expect(html.match(/<span class="sr-only">Not allowed<\/span>/g)).toHaveLength(none);
    expect(html).not.toMatch(/text-fg-4/);
    expect(html).toContain("Source admin is granted and removed only by an app admin, not by a space admin.");
    expect(html).toContain("The approver can&#x27;t be the preparer or anyone who resolved an item that day. Approving freezes the day.");
  });
});
