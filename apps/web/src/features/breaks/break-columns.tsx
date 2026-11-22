"use client";

import Link from "next/link";
import { type Column, Truncate } from "@starterkit/ui/ds";
import { formatDate } from "@starterkit/ui/lib/format";
import type { BreakRowDto } from "@starterkit/shared/contracts/breaks";
import type { AgeBucket, BreakState } from "@starterkit/shared/recon";
import { amountText } from "@/lib/shared/amount";

/** A break's queue state as people say it. */
export const STATE_LABEL: Record<BreakState, string> = {
  new: "New", assigned: "Assigned", investigating: "Investigating", pending_external: "Pending external",
  proposed_resolution: "Proposed resolution", pending_approval: "Pending approval", resolved: "Resolved",
};
/** An age bucket as people say it (days from the break's business date). */
export const AGE_LABEL: Record<AgeBucket, string> = { d0: "Today", d1: "1 day", d2_3: "2–3 days", d4_7: "4–7 days", d8_30: "8–30 days", gt30: "Over 30 days" };
const ageText = (n: number) => (n === 0 ? "Today" : n === 1 ? "1 day old" : `${n} days old`);
const dateText = (d: string) => formatDate(Date.parse(`${d}T00:00:00+07:00`));

export type Selection = { has: (id: string) => boolean; toggle: (id: string) => void; all: { checked: boolean; count: number; toggle: () => void } };

/**
 * Columns of the breaks queue: the break (its reference, recon, side and source), its business date and age, amount,
 * why it broke (and a pair a later pass proposed), where it stands, who has it. `select` adds the leading checkbox for
 * the bulk actions.
 */
export function breakColumns(spaceId: string, select?: Selection): Column<BreakRowDto>[] {
  const href = (r: BreakRowDto) => `/spaces/${encodeURIComponent(spaceId)}/breaks/${encodeURIComponent(r.id)}`;
  const cols: Column<BreakRowDto>[] = [
    { key: "break", header: "Break", mobile: "title", className: "min-w-56", cell: (r) => (
      <span className="grid min-w-0 max-w-80">
        <Truncate title={r.ref ?? "No reference"}><Link href={href(r)} className="font-mono text-body-sm font-medium text-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">{r.ref ?? "No reference"}</Link></Truncate>
        <span className="truncate text-caption text-fg-3">{r.recon.name} · side {r.side.toUpperCase()}{r.source ? ` · ${r.source}` : ""}</span>
      </span>
    ) },
    { key: "businessDate", header: "Business date", sortable: true, mobile: "meta", className: "whitespace-nowrap", cell: (r) => (
      <span className="grid">
        <span>{dateText(r.businessDate)}</span>
        <span className="text-caption text-fg-3">{ageText(r.ageDays)}</span>
      </span>
    ) },
    { key: "amount", header: "Amount", mobile: "meta", align: "right", className: "whitespace-nowrap", cell: (r) => (
      <span className="tabular">{amountText(r.amountMinor, r.currency)}{r.currency ? <span className="ml-1 text-caption text-fg-3">{r.currency}</span> : null}</span>
    ) },
    { key: "reason", header: "Reason", mobile: "meta", className: "min-w-40", cell: (r) => (
      <span className="grid">
        <span>{r.reason ?? "—"}</span>
        {r.proposedRef && <span className="truncate text-caption text-fg-3" title={r.proposedRef}>Pair proposed: {r.proposedRef}</span>}
      </span>
    ) },
    { key: "state", header: "State", mobile: "meta", className: "whitespace-nowrap", cell: (r) => STATE_LABEL[r.state] },
    { key: "assignee", header: "Assignee", mobile: "meta", cell: (r) => (r.assignee ? (r.assignee.name ?? "A removed user") : <span className="text-fg-3">Unassigned</span>) },
  ];
  if (!select) return cols;
  // the header's checkbox selects the page (tablet and desktop); on a phone the bulk bar holds it
  const all = <input type="checkbox" aria-label={`Select all ${select.all.count} on this page`} checked={select.all.checked} onChange={select.all.toggle} className="size-4 cursor-pointer accent-primary" />;
  return [{ key: "select", header: "Select", headerCell: all, className: "w-8", mobile: "lead", cell: (r) => (
    <label className="inline-grid size-7 cursor-pointer place-items-center">
      <input type="checkbox" aria-label={`Select ${r.ref ?? "break"}`} checked={select.has(r.id)} onChange={() => select.toggle(r.id)} className="size-4 cursor-pointer accent-primary" />
    </label>
  ) }, ...cols];
}
