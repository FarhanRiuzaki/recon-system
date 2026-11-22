import { createElement as h, Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ApprovalRowDto } from "@starterkit/shared/contracts/approvals";
import { approvalColumns, chainText } from "./approval-columns";

const COLS = approvalColumns("sp-1");
const R = {
  kind: "force_match", id: "q1", target: { id: "b1", code: "REF-1", name: "BI-FAST" }, version: null, submitter: { id: "u1", name: "Maker" },
  submittedAt: "2026-11-20T01:00:00Z", blocked: null, level: { at: 1, of: 2 }, amount: { minor: "3607350000", currency: "IDR" }, difference: { minor: "10000", currency: "IDR" }, workflowName: "Treasury head",
} as ApprovalRowDto;
const cell = (key: string, r: ApprovalRowDto = R) => renderToStaticMarkup(h(Fragment, null, COLS.find((c) => c.key === key)!.cell(r)));

describe("approvals inbox columns (audit §5.2)", () => {
  it("change, amount, difference, workflow, sent by, waiting since, waiting for: seven, in that order", () => {
    expect(COLS.map((c) => c.header)).toEqual(["Change", "Amount", "Difference", "Workflow", "Sent by", "Waiting since", "Waiting for"]);
  });
  it("amounts in the currency's format; a version has none; the workflow with its level, the default chain by name", () => {
    expect(cell("amount")).toContain("36,073,500.00");
    expect(cell("difference", { ...R, difference: null })).toContain("—");
    expect(chainText(R)).toBe("Treasury head · level 1 of 2");
    expect(chainText({ ...R, workflowName: null, level: { at: 1, of: 1 } })).toBe("Default chain · level 1 of 1");
    expect(chainText({ ...R, kind: "recon_version", version: 3, level: null, workflowName: null })).toBe("Config checker");
  });
  it("waiting for the viewer: You and Review; else why not", () => {
    expect(cell("decision")).toContain("Review");
    expect(cell("decision", { ...R, blocked: "Level 1 waits for 1 of Reviewer." })).toContain("Level 1 waits for 1 of Reviewer.");
  });
});
