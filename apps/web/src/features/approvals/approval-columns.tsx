"use client";

import Link from "next/link";
import { CategoryChip, type Column, RelativeTime, Truncate } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { ArrowRightIcon } from "@starterkit/ui/ui/icons";
import { APPROVAL_KIND_LABEL, isRequestKind } from "@starterkit/shared/approvals";
import type { ApprovalRowDto } from "@starterkit/shared/contracts/approvals";
import { amountText } from "@/lib/shared/amount";
import { categoryChip } from "@/lib/shared/categories";
import { APPROVALS_FROM } from "@/lib/shared/nav";

const LINK = "font-medium text-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

/** The page a request is decided on: the version's own review (its diff, simulation and Approve / Reject), back here after. */
export const approvalHref = (spaceId: string, r: ApprovalRowDto) => isRequestKind(r.kind)
  ? `/spaces/${encodeURIComponent(spaceId)}/breaks/${encodeURIComponent(r.target.id)}`
  : `/spaces/${encodeURIComponent(spaceId)}/${r.kind === "source_version" ? "sources" : r.kind === "report_version" ? "reports/templates" : "recons"}/${encodeURIComponent(r.target.id)}/versions/${encodeURIComponent(r.id)}?from=${APPROVALS_FROM}`;

const money = (m: ApprovalRowDto["amount"]) => (m
  ? <span className="tabular">{amountText(m.minor, m.currency)}{m.currency ? <span className="ml-1 text-caption text-fg-3">{m.currency}</span> : null}</span>
  : <span className="text-fg-3">—</span>);

/** Where a request is in its chain: "Treasury head · level 1 of 2", the default chain by name; a version goes to a config checker. */
export const chainText = (r: ApprovalRowDto) => (isRequestKind(r.kind)
  ? `${r.workflowName ?? "Default chain"}${r.level ? ` · level ${r.level.at} of ${r.level.of}` : ""}`
  : "Config checker");

/**
 * Columns of the approvals inbox (audit §5.2): the change (its kind and target), the item's amount and a force match's
 * difference, its workflow and level, who sent it, how long it has waited, and who it waits for (Review when it is the
 * viewer, else why not). Sent and name sort (APPROVAL_SORTS).
 */
export function approvalColumns(spaceId: string): Column<ApprovalRowDto>[] {
  return [
    { key: "name", header: "Change", sortable: true, mobile: "title", className: "min-w-48", cell: (r) => (
      <span className="grid min-w-0 max-w-72">
        <Truncate title={r.target.name}><Link href={approvalHref(spaceId, r)} className={LINK}>{r.target.name}</Link></Truncate>
        <span className="flex min-w-0 items-center gap-2">
          <CategoryChip label={`${APPROVAL_KIND_LABEL[r.kind]}${r.version === null ? "" : ` ${r.version}`}`} slot={categoryChip("changeKind", r.kind)} />
          <span className="truncate text-caption text-fg-3">{r.target.code}</span>
        </span>
      </span>
    ) },
    { key: "amount", header: "Amount", mobile: "meta", align: "right", className: "whitespace-nowrap", cell: (r) => money(r.amount) },
    { key: "difference", header: "Difference", mobile: "meta", align: "right", className: "whitespace-nowrap", cell: (r) => money(r.difference) },
    { key: "workflow", header: "Workflow", mobile: "meta", className: "max-w-56", cell: (r) => <span className="block truncate" title={chainText(r)}>{chainText(r)}</span> },
    { key: "submitter", header: "Sent by", mobile: "meta", cell: (r) => r.submitter?.name ?? <span className="text-fg-3">A removed user</span> },
    { key: "submittedAt", header: "Waiting since", sortable: true, mobile: "meta", className: "whitespace-nowrap",
      cell: (r) => (r.submittedAt ? <RelativeTime at={Date.parse(r.submittedAt)} /> : <span className="text-fg-3">—</span>) },
    { key: "decision", header: "Waiting for", mobile: "meta", hideable: false, className: "min-w-48", cell: (r) => r.blocked
      ? <span className="text-body-sm text-fg-3">{r.blocked}</span>
      // a link to where it is decided, one per row: the page's primary stays the decision itself (P6)
      : <span className="flex items-center gap-2">You<Button asChild variant="link" size="sm"><Link href={approvalHref(spaceId, r)}>Review<Icon icon={ArrowRightIcon} /></Link></Button></span> },
  ];
}
