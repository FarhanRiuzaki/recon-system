import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ROLE_LABEL, SPACE_ACTION, SPACE_ROLES, type SpaceAction } from "@starterkit/shared/spaces";
import { DEFAULT_LEVELS } from "@starterkit/shared/workflows";
import { ROLE_MATRIX, RoleMatrix } from "./role-matrix";

const rows = ROLE_MATRIX.flatMap((g) => g.rows);
const row = (action: string) => rows.find((r) => r.action === action)!.cells;
const D = "does", A = "approves", V = "views", N = "none";
/** The roles whose cell in `cells` is one of `kinds`, in SPACE_ROLES order. */
const holding = (cells: readonly string[], ...kinds: string[]) => SPACE_ROLES.filter((_, i) => kinds.includes(cells[i]!));

describe("RoleMatrix: 7 roles × the actions the API guards (SPACE_ACTION)", () => {
  it("the actions in three groups, a cell per role", () => {
    expect(ROLE_MATRIX.map((g) => [g.group, g.rows.map((r) => r.action)])).toEqual([
      ["Daily work", ["View recons, today, unmatch items and operation result", "View postings and posting groups", "View a source's files, pulls and records",
        "View the dashboard of the spaces you are in", "See the sidebar counts", "See and download inbox files", "Upload a file to the inbox", "Take an item and set its state", "Assign items to someone", "Run a recon now", "Roll back a run",
        "Match", "Request posting", "Force match", "Write-off", "Close without a match", "Undo match", "Work an item from Explain in operation result",
        "Approve requests", "Sign off a day", "See and download reports", "Make a report for a date range", "Download a report with full customer data"]],
      ["Setup", ["Set up recons", "Run a simulation", "Preview a posting request", "Choose operation result columns", "Delete a recon",
        "Set up sources", "Connect a source and pull it", "Manage inbox folders and delete files", "Set up workflows", "Set up report templates"]],
      ["Space", ["Manage members", "Share a source with another space"]],
    ]);
    for (const r of rows) expect(r.cells, r.action).toHaveLength(SPACE_ROLES.length);
  });

  it("every space action is a row, and each row's cells are the roles its API guard lets in", () => {
    const seen = new Set<SpaceAction>();
    for (const r of rows) {
      if (r.does) { seen.add(r.does); expect(holding(r.cells, D), r.action).toEqual(SPACE_ROLES.filter((x) => (SPACE_ACTION[r.does!] as readonly string[]).includes(x))); }
      if (r.approves && r.approves !== "chain") { seen.add(r.approves); expect(holding(r.cells, A), r.action).toEqual(SPACE_ROLES.filter((x) => (SPACE_ACTION[r.approves as SpaceAction] as readonly string[]).includes(x))); }
      for (const k of r.covers ?? []) { seen.add(k); expect(holding(r.cells, D, A), `${r.action} covers ${k}`).toEqual(SPACE_ROLES.filter((x) => (SPACE_ACTION[k] as readonly string[]).includes(x))); }
    }
    expect([...seen].sort()).toEqual(Object.keys(SPACE_ACTION).sort());
  });

  it("requests are approved by the default chain's roles; the work rows match the API's lists", () => {
    const chain = new Set(DEFAULT_LEVELS.flatMap((l) => l.groups.flatMap((g) => g.spaceRoles)));
    expect(holding(row("Approve requests"), A)).toEqual(SPACE_ROLES.filter((r) => chain.has(r)));
    const worker = [D, N, N, N, D, D, N];
    for (const a of ["Match", "Request posting", "Force match", "Write-off", "Close without a match", "Undo match", "Take an item and set its state", "Work an item from Explain in operation result"]) expect(row(a), a).toEqual(worker);
    expect(row("Run a recon now")).toEqual([D, N, D, N, D, N, N]);
    expect(row("Roll back a run")).toEqual([D, N, N, N, N, N, N]);
    expect(row("Choose operation result columns")).toEqual([D, N, D, N, N, N, N]);
    expect(row("Set up recons")).toEqual([N, N, D, A, N, N, N]);
    expect(row("Set up sources")).toEqual([N, D, D, A, N, N, N]);
    expect(row("Connect a source and pull it")).toEqual([N, D, N, N, N, N, N]);
    // reads: every member (the API's SPACE_ROLES guards), the source admin too
    for (const a of ["View recons, today, unmatch items and operation result", "View postings and posting groups", "See the sidebar counts"]) expect(row(a), a).toEqual(Array(7).fill(V));
  });

  it("renders a table with the roles as columns; a dash cell says Not allowed to a screen reader; the app roles under it", () => {
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
    expect(html).toContain("A Superadmin holds every role in every space.");
    expect(html).toContain("Open API: Integration view reads connectors and their call log");
  });
});
