import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@starterkit/ui/ui/tooltip";
import type { SourceSnapshotDto } from "@starterkit/shared/contracts/sources";
import { PullAgain, pullAgainReason, reasonsText } from "./ingest-tables";

const row = (closed: boolean): SourceSnapshotDto => ({ id: "s", businessDate: "2026-11-02", status: "active", rows: 11, error: null, startedAt: "2026-11-02T23:00:00.000Z", finishedAt: null, closed });
const render = (r: SourceSnapshotDto, blocked: string | null) =>
  renderToStaticMarkup(h(TooltipProvider, null, h(PullAgain, { row: r, blocked, pending: false, onPull: () => {} })));

describe("Pull <date> again (Figma 27:7215, 31:7924, state d)", () => {
  it("a closed day is a BlockedButton with the rerun reason, whatever the role", () => {
    const reason = "Day 2 Nov is closed. Re-running it needs a rerun request (later release).";
    expect(pullAgainReason(row(true), null)).toBe(reason);
    expect(pullAgainReason(row(true), "Only a source admin of this space starts a pull.")).toBe(reason);
    const html = render(row(true), null);
    expect(html).toContain("Pull 2 Nov again");
    expect(html).toContain('aria-disabled="true"');
    expect(html).toContain(reason);
  });
  it("an open day: the button for a source admin; the role's reason for anyone else", () => {
    expect(render(row(false), null)).not.toContain("aria-disabled");
    expect(render(row(false), "Only a source admin of this space starts a pull.")).toContain("Only a source admin of this space starts a pull.");
  });
});

describe("quarantine reasons", () => {
  it("per column, and a whole-line fault alone", () => {
    expect(reasonsText({ sid: "Empty; sid can't be empty", opened_on: "'20211301' isn't a date" })).toBe("sid: Empty; sid can't be empty · opened_on: '20211301' isn't a date");
    expect(reasonsText({ _row: "Expected 14 columns, found 13" })).toBe("Expected 14 columns, found 13");
  });
});
