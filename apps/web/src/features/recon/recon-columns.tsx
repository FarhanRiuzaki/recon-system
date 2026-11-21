import Link from "next/link";
import { type Column, StatusChip, Truncate } from "@starterkit/ui/ds";
import { formatDate } from "@starterkit/ui/lib/format";
import type { ReconRowDto } from "@starterkit/shared/contracts/recon";
import { reconStatus } from "@/lib/shared/recon-status";
import { reconHref } from "./use-recons";

const LINK = "font-medium text-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";

/** "Version 2 · bifast-credit"; before the first approval the open version's state, as the chip says it: "Draft · code", "In review · code". */
export const reconCaption = (r: Pick<ReconRowDto, "publishedVersion" | "draftStatus" | "code">) =>
  `${r.publishedVersion ? `Version ${r.publishedVersion}` : r.draftStatus === "in_review" ? "In review" : "Draft"} · ${r.code}`;

/** Columns of a space's recons: the recon (title on a phone), its state, when it was created. Name and created sort (RECON_SORTS). */
export function reconColumns(spaceId: string): Column<ReconRowDto>[] {
  return [
    { key: "name", header: "Recon", sortable: true, mobile: "title", className: "min-w-56", cell: (r) => (
      <span className="grid min-w-0 max-w-96">
        <Truncate title={r.name}><Link href={reconHref(spaceId, r.id)} className={LINK}>{r.name}</Link></Truncate>
        <span className="truncate text-caption text-fg-3">{reconCaption(r)}</span>
      </span>
    ) },
    { key: "state", header: "State", mobile: "meta", cell: (r) => { const s = reconStatus(r); return <StatusChip health={s.health} label={s.label} />; } },
    { key: "createdAt", header: "Created", sortable: true, mobile: "meta", cell: (r) => formatDate(Date.parse(r.createdAt)) },
  ];
}
