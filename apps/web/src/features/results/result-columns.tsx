"use client";

import Link from "next/link";
import { type Column, StatusChip, Truncate } from "@starterkit/ui/ds";
import { cn } from "@starterkit/ui/lib/cn";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { ArrowRightIcon, InfoIcon } from "@starterkit/ui/ui/icons";
import { CELL_TRUNCATE } from "@starterkit/ui/ui/table";
import type { ResultColumn, ResultRowDto } from "@starterkit/shared/contracts/results";
import { cellKey, cellText, columnKey, MISSING_TEXT, resultIcon, sideIcon } from "./result-model";

/** The columns the API sorts by: a configured column of that field takes the sort's key. */
const SORT_KEY: Record<string, string> = { "a:amount_minor": "amountA", "a:ext_ref": "ref", "recon:businessDate": "businessDate" };

function Side({ s }: { s: ResultRowDto["a"] }) {
  const { chip, count } = sideIcon(s);
  return <span className="inline-flex items-center gap-1.5 whitespace-nowrap"><StatusChip health={chip.health} label={chip.label} />{count && <span className="text-caption text-fg-3">{count}</span>}</span>;
}

/**
 * The results table: Status, each side (A, B by the sides' labels), the recon's configured columns in their order,
 * then Explain and, on a lone item that is or was unmatch, Open (its Unmatch page).
 */
export function resultColumns(spaceId: string, columns: readonly ResultColumn[], sides: readonly [string, string], onExplain: (r: ResultRowDto) => void): Column<ResultRowDto>[] {
  const configured = columns.map((c): Column<ResultRowDto> => {
    const amount = c.kind !== "recon" && c.field === "amount_minor";
    const sortKey = SORT_KEY[cellKey(c)];
    return {
      key: sortKey ?? columnKey(c), header: c.label, sortable: !!sortKey, mobile: "meta", align: amount ? "right" : undefined,
      className: cn(amount ? "whitespace-nowrap tabular" : "max-w-56", !amount && CELL_TRUNCATE),
      cell: (r) => {
        const cell = r.cells[cellKey(c)], text = cellText(cell, c);
        const quiet = text === "–" || cell?.missing || !!cell?.many || (amount && cell?.value === "Mixed");
        return amount ? <span className={cn(quiet && "text-fg-3")}>{text}</span> : <Truncate title={text}><span className={cn(quiet && "text-fg-3", text === MISSING_TEXT && "italic")}>{text}</span></Truncate>;
      },
    };
  });
  return [
    { key: "status", header: "Status", sortable: true, mobile: "title", hideable: false, className: "whitespace-nowrap", cell: (r) => { const c = resultIcon(r.status).chip; return <StatusChip health={c.health} label={c.label} />; } },
    { key: "sideA", header: sides[0], mobile: "meta", cell: (r) => <Side s={r.a} /> },
    { key: "sideB", header: sides[1], mobile: "meta", cell: (r) => <Side s={r.b} /> },
    ...configured,
    { key: "action", header: "Action", mobile: "meta", hideable: false, className: "whitespace-nowrap", cell: (r) => (
      <span className="inline-flex items-center gap-1">
        <Button size="sm" variant="ghost" onClick={() => onExplain(r)}><Icon icon={InfoIcon} />Explain</Button>
        {r.openItemId && <Button asChild size="sm" variant="link"><Link href={`/spaces/${encodeURIComponent(spaceId)}/breaks/${encodeURIComponent(r.openItemId)}`}>Open<Icon icon={ArrowRightIcon} /></Link></Button>}
      </span>
    ) },
  ];
}
