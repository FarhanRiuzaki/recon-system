"use client";

import Link from "next/link";
import { CategoryChip, type Column, StatusChip, Truncate } from "@starterkit/ui/ds";
import { formatDate } from "@starterkit/ui/lib/format";
import type { BreakRowDto } from "@starterkit/shared/contracts/breaks";
import { Icon } from "@starterkit/ui/ui/icon";
import { SuggestedIcon } from "@starterkit/ui/ui/icons";
import { CELL_TRUNCATE } from "@starterkit/ui/ui/table";
import { cn } from "@starterkit/ui/lib/cn";
import { amountText } from "@/lib/shared/amount";
import { categoryChip, STATES } from "@/lib/shared/categories";
import { checkChip, STATE_LABEL } from "./break-model";

const ageText = (n: number) => (n === 0 ? "Today" : n === 1 ? "1 day old" : `${n} days old`);
const dateText = (d: string) => formatDate(Date.parse(`${d}T00:00:00+07:00`));

export type Selection = { has: (id: string) => boolean; toggle: (id: string) => void; all: { checked: boolean; count: number; toggle: () => void } };

/** The business date the API counted the row's age to (its today). */
const rowToday = (r: BreakRowDto) => new Date(Date.parse(`${r.businessDate}T00:00:00Z`) + r.ageDays * 86_400_000).toISOString().slice(0, 10);
const chipOf = (r: BreakRowDto) => checkChip(r.recheck, rowToday(r), r.state === "pending_approval");
const CheckChip = ({ label }: { label: string | null }) => (label ? <CategoryChip label={label} slot="neutral" /> : null);

/** Until when runs check an item again, in words. */
export const recheckText = (r: BreakRowDto["recheck"]) => (r.kind === "until" ? dateText(r.date) : r.kind === "always" ? "Every run" : "Not checked again");

/**
 * Columns of the unmatch queue (audit §5.1): the item (its reference, its source), business date and age, amount,
 * why it broke, a pair a later pass proposed, where it stands, who has it; hidden until chosen: the counterpart's side,
 * until when runs check it again, and its recon. `select` adds the leading checkbox for the bulk actions.
 */
export function breakColumns(spaceId: string, select?: Selection): Column<BreakRowDto>[] {
  const href = (r: BreakRowDto) => `/spaces/${encodeURIComponent(spaceId)}/breaks/${encodeURIComponent(r.id)}`;
  const cols: Column<BreakRowDto>[] = [
    // the reference on one line, cut with its tooltip past the column (a machine id wraps into a third line otherwise)
    { key: "break", header: "Item", mobile: "title", className: cn("min-w-48", CELL_TRUNCATE), cell: (r) => (
      <span className="grid min-w-0 max-w-72">
        <Truncate title={r.ref ?? "No reference"}><Link href={href(r)} className="font-mono text-body-sm font-medium text-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">{r.ref ?? "No reference"}</Link></Truncate>
        {r.source && <span className="truncate text-caption text-fg-3">{r.source}</span>}
      </span>
    ) },
    { key: "businessDate", header: "Business date", sortable: true, mobile: "meta", className: "whitespace-nowrap", cell: (r) => (
      <span className="grid">
        <span>{dateText(r.businessDate)}</span>
        <span className="text-caption text-fg-3">{ageText(r.ageDays)}</span>
      </span>
    ) },
    { key: "amount", header: "Amount", sortable: true, mobile: "meta", align: "right", className: "whitespace-nowrap", cell: (r) => (
      <span className="tabular">{amountText(r.amountMinor, r.currency)}{r.currency ? <span className="ml-1 text-caption text-fg-3">{r.currency}</span> : null}</span>
    ) },
    { key: "counterpartSide", header: "Counterpart side", mobile: "meta", defaultHidden: true, className: "whitespace-nowrap", cell: (r) => r.counterpartSide ?? <span className="text-fg-3">–</span> },
    { key: "reason", header: "Reason", mobile: "meta", className: "whitespace-nowrap", cell: (r) => (
      r.reason ? <CategoryChip label={r.reason} slot={categoryChip("reason", r.reason)} /> : <span className="text-fg-3">–</span>
    ) },
    { key: "proposed", header: "Proposed pair", mobile: "meta", className: "max-w-48", cell: (r) => (
      r.proposedRef
        ? <CategoryChip label={r.proposedRef} slot="neutral" className="font-mono"><Icon icon={SuggestedIcon} className="size-3.5 shrink-0 text-fg-3" /></CategoryChip>
        : <span className="text-fg-3">–</span>
    ) },
    // one chip (review 24 Nov: rows 52 px at most); whether runs still check it lives in Checked until
    { key: "state", header: "State", sortable: true, mobile: "meta", className: "whitespace-nowrap", cell: (r) => <StatusChip label={STATE_LABEL[r.state]} health={STATES.workState[r.state]} /> },
    { key: "assignee", header: "Assignee", mobile: "meta", className: "whitespace-nowrap", cell: (r) => (r.assignee ? (r.assignee.name ?? "A removed user") : <span className="text-fg-3">Unassigned</span>) },
    { key: "recheck", header: "Checked until", mobile: "meta", defaultHidden: true, className: "whitespace-nowrap", cell: (r) => (
      r.recheck.kind === "no" ? <CheckChip label={chipOf(r)} />
        : chipOf(r) ? <span className="inline-flex items-center gap-1.5">{recheckText(r.recheck)}<CheckChip label={chipOf(r)} /></span> : recheckText(r.recheck)
    ) },
    { key: "recon", header: "Recon", mobile: "meta", defaultHidden: true, className: "whitespace-nowrap", cell: (r) => r.recon.name },
  ];
  if (!select) return cols;
  // the header's checkbox selects the page (tablet and desktop); on a phone the bulk bar holds it
  const all = <input type="checkbox" aria-label={`Select all ${select.all.count} on this page`} checked={select.all.checked} onChange={select.all.toggle} className="size-4 cursor-pointer accent-primary" />;
  return [{ key: "select", header: "Select", headerCell: all, className: "w-8", mobile: "lead", cell: (r) => (
    <label className="inline-grid size-7 cursor-pointer place-items-center">
      <input type="checkbox" aria-label={`Select ${r.ref ?? "item"}`} checked={select.has(r.id)} onChange={() => select.toggle(r.id)} className="size-4 cursor-pointer accent-primary" />
    </label>
  ) }, ...cols];
}
