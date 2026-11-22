"use client";

import Link from "next/link";
import { type Column, RelativeTime, Truncate } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { APPROVAL_KIND_LABEL, isRequestKind } from "@starterkit/shared/approvals";
import type { ApprovalRowDto } from "@starterkit/shared/contracts/approvals";
import { APPROVALS_FROM } from "@/lib/shared/nav";

const LINK = "font-medium text-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

/** The page a request is decided on: the version's own review (its diff, simulation and Approve / Reject), back here after. */
export const approvalHref = (spaceId: string, r: ApprovalRowDto) => isRequestKind(r.kind)
  ? `/spaces/${encodeURIComponent(spaceId)}/breaks/${encodeURIComponent(r.target.id)}`
  : `/spaces/${encodeURIComponent(spaceId)}/${r.kind === "source_version" ? "sources" : "recons"}/${encodeURIComponent(r.target.id)}/versions/${encodeURIComponent(r.id)}?from=${APPROVALS_FROM}`;

/**
 * Columns of the approvals inbox: what is asked (the source or recon and its version), who sent it, how long it has
 * waited, and what the viewer can do (Review, or why it isn't theirs to decide). Sent and name sort (APPROVAL_SORTS).
 */
export function approvalColumns(spaceId: string): Column<ApprovalRowDto>[] {
  return [
    { key: "name", header: "Request", sortable: true, mobile: "title", className: "min-w-56", cell: (r) => (
      <span className="grid min-w-0 max-w-80">
        <Truncate title={r.target.name}><Link href={approvalHref(spaceId, r)} className={LINK}>{r.target.name}</Link></Truncate>
        <span className="truncate text-caption text-fg-3">{APPROVAL_KIND_LABEL[r.kind]}{r.version === null ? "" : ` ${r.version}`} · {r.target.code}</span>
      </span>
    ) },
    { key: "submitter", header: "Sent by", mobile: "meta", cell: (r) => r.submitter?.name ?? <span className="text-fg-3">A removed user</span> },
    { key: "submittedAt", header: "Waiting since", sortable: true, mobile: "meta", className: "whitespace-nowrap",
      cell: (r) => (r.submittedAt ? <RelativeTime at={Date.parse(r.submittedAt)} /> : <span className="text-fg-3">—</span>) },
    { key: "decision", header: "Your decision", mobile: "meta", hideable: false, className: "min-w-56", cell: (r) => r.blocked
      ? <span className="text-body-sm text-fg-3">{r.blocked}</span>
      : <Button asChild size="sm"><Link href={approvalHref(spaceId, r)}>Review</Link></Button> },
  ];
}
