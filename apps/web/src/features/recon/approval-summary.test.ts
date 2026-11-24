import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ReconSpec } from "@starterkit/shared/contracts/recon";
import { connectorOperationsQuery, workflowOptions } from "@/lib/shared/queries-recon";
import { ApprovalSummary } from "./approval-summary";

// The version review's Approval part (maker-checker): a checker sees the accounts, the lookup tables and every action's
// variants, and what of them differs from the live version.
const ops = { items: [{ id: "c1", name: "Bank Mega", disabled: false, versions: [{ version: 2, live: true, operations: [{ key: "post", name: "Post GL", method: "POST", path: "/gl", fixed: [], auto: [], masked: ["Account"],
  request: [{ name: "Amount", type: "numeric" as const, required: true }, { name: "Account", type: "string" as const, required: true }] }] }] }] };
const variant = { name: "Default", when: null, operation: { connectorId: "c1", version: 2, key: "post" }, per: "item" as const, zeroOrNegative: "skip" as const,
  mapping: { Amount: { kind: "field" as const, key: "break.amount", transforms: [] }, Account: { kind: "account" as const, account: "susp", part: "number" as const } } };
const approvals = (number: string, zero: "skip" | "absolute_swap"): NonNullable<ReconSpec["approvals"]> => ({
  accounts: [{ key: "susp", label: "Suspense", number, currency: "IDR" }], lookups: [{ name: "branch", rows: [{ key: "001", value: "Jakarta" }] }],
  changes: { posting: { workflow: { default: null, rules: [] }, actions: [{ name: "Post to GL", kind: "posting", on: { event: "approved" }, variants: [{ ...variant, zeroOrNegative: zero }] }] } },
});

function render(next: NonNullable<ReconSpec["approvals"]>, live?: NonNullable<ReconSpec["approvals"]>) {
  const qc = new QueryClient();
  qc.setQueryData(connectorOperationsQuery("s1").key, ops);
  qc.setQueryData(workflowOptions("s1").key, { items: [], total: 0, page: 1, pageSize: 100 });
  const catalog = [{ key: "break.amount", label: "Amount", group: "break" as const, kind: "money" as const }];
  return renderToStaticMarkup(h(QueryClientProvider, { client: qc }, h(ApprovalSummary, { spaceId: "s1", approvals: next, catalog, live: live ? ({ approvals: live } as ReconSpec) : undefined })));
}
const count = (html: string, text: string) => html.split(text).length - 1;

describe("ApprovalSummary on a version review", () => {
  it("shows the accounts, the lookup rows and each action's variant in full", () => {
    const html = render(approvals("1001", "skip"));
    for (const t of ["Suspense", "1001 · IDR", "branch", "Jakarta", "When the change is approved, post Post to GL", "Bank Mega · version 2 · Post GL", "One call per item", "An amount of 0 or below", "Skip it", "Suspense&#x27;s number", "Masked"])
      expect(html).toContain(t);
    expect(html).not.toContain("Changed from the live version");
  });
  it("marks a changed account number and a changed variant, with the live version's beside them", () => {
    const html = render(approvals("1002", "absolute_swap"), approvals("1001", "skip"));
    expect(html).toContain("1002 · IDR");
    expect(html).toContain("1001 · IDR"); // the live version's account, under the mark
    // the Posting change, its changed variant and the accounts; the lookups are the same
    expect(count(html, "Changed from the live version")).toBe(3);
    expect(html).toContain("Post it without the sign, sides swapped");
  });
});
