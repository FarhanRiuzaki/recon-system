"use client";

import Link from "next/link";
import { type Column, StatusGlyph, Truncate } from "@starterkit/ui/ds";
import { cn } from "@starterkit/ui/lib/cn";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { ArrowRightIcon, InfoIcon } from "@starterkit/ui/ui/icons";
import { CELL_TRUNCATE } from "@starterkit/ui/ui/table";
import type { ResultColumn, ResultRowDto } from "@starterkit/shared/contracts/results";
import { cellKey, cellText, columnKey, MISSING_TEXT, resultIcon, SIDE_HEADER, sideHelp, sideIcon } from "./result-model";

/** The columns the API sorts by: a configured column of that field takes the sort's key. */
const SORT_KEY: Record<string, string> = { "a:amount_minor": "amountA", "a:ext_ref": "ref", "recon:businessDate": "businessDate" };

/** A hairline right of Status, Side A and Side B (owner 24 Nov: "garis pembatas status | side A | side B"), from 768 px (below it the table is cards). */
const DIVIDER = "md:border-r md:border-r-line";

function Side({ s }: { s: ResultRowDto["a"] }) {
  const { icon, chip, count } = sideIcon(s);
  // the owner's picture (24 Nov): ✓ green, ✕ red, – grey, with how many records when more than one ("✓ 3")
  return <span className="inline-flex items-center gap-1 whitespace-nowrap"><StatusGlyph health={chip.health} icon={icon} label={count ? `${chip.label}, ${count}` : chip.label} />{count && <span aria-hidden="true" className="text-caption tabular text-fg-2">{s.count}</span>}</span>;
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
  // Status and each side: icons, centred, and stuck to the left while the table scrolls sideways (owner 24 Nov); a side
  // is headed "Side A" with its source's name behind the ⓘ
  return [
    { key: "status", header: "Status", sortable: true, mobile: "title", hideable: false, align: "center", sticky: true, className: cn("whitespace-nowrap", DIVIDER), cell: (r) => { const x = resultIcon(r.status); return <StatusGlyph health={x.chip.health} icon={x.icon} label={x.chip.label} />; } },
    { key: "sideA", header: SIDE_HEADER[0], help: sideHelp(0, sides), mobile: "meta", align: "center", sticky: true, className: DIVIDER, cell: (r) => <Side s={r.a} /> },
    { key: "sideB", header: SIDE_HEADER[1], help: sideHelp(1, sides), mobile: "meta", align: "center", sticky: true, className: DIVIDER, cell: (r) => <Side s={r.b} /> },
    ...configured,
    { key: "action", header: "Action", mobile: "meta", hideable: false, className: "whitespace-nowrap", cell: (r) => (
      <span className="inline-flex items-center gap-1">
        <Button size="sm" variant="ghost" onClick={() => onExplain(r)}><Icon icon={InfoIcon} />Explain</Button>
        {r.openItemId && <Button asChild size="sm" variant="link"><Link href={`/spaces/${encodeURIComponent(spaceId)}/breaks/${encodeURIComponent(r.openItemId)}`}>Open<Icon icon={ArrowRightIcon} /></Link></Button>}
      </span>
    ) },
  ];
}
