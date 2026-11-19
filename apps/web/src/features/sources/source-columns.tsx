import Link from "next/link";
import { type Column, StatusChip, Truncate } from "@starterkit/ui/ds";
import { formatNumber } from "@starterkit/ui/lib/format";
import type { SourceRowDto } from "@starterkit/shared/contracts/sources";
import { sourceStatus } from "@/lib/shared/source-status";
import { completeText, KIND_LABEL, lagText, withDays } from "./source-text";
import { sourceHref } from "./use-sources";

const LINK = "font-medium text-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const none = <span className="text-fg-3">—</span>;

/** A source's state chip with the API's reason (or last error) as its description. */
export function SourceStatusChip({ s }: { s: SourceRowDto }) {
  const st = sourceStatus(s);
  const why = s.health?.reason ?? s.health?.lastError ?? null;
  return <StatusChip health={st.health} label={st.label} description={why ? withDays(why) : null} />;
}

/** "v1 · bi-settlement", "Draft · code", or, through a share, who owns it. */
export const sourceCaption = (s: SourceRowDto) =>
  s.owner ? `Read-only here · owned by ${s.owner.name}` : `${s.publishedVersion ? `Version ${s.publishedVersion}` : "Draft"} · ${s.code}`;

/**
 * Columns of a space's sources (Figma 17:5543, Build notes 02: Source · Kind · State · Complete through · Quarantined
 * today; rows of the business date in progress beside it). Phone card: the source is the title, the rest lines under
 * it. Tablet (768–1279) shows Kind and State only. Name and created sort (the API's SOURCE_SORTS).
 */
export function sourceColumns(spaceId: string): Column<SourceRowDto>[] {
  return [
    { key: "name", header: "Source", sortable: true, mobile: "title", className: "min-w-56", cell: (s) => (
      <span className="grid min-w-0 max-w-80">
        <Truncate title={s.name}><Link href={sourceHref(spaceId, s.id)} className={LINK}>{s.name}</Link></Truncate>
        <span className="truncate text-caption text-fg-3">{sourceCaption(s)}</span>
      </span>
    ) },
    // plain text: a tint per kind would carry no information and follows the palette (REC-D5)
    { key: "kind", header: "Kind", mobile: "meta", cell: (s) => <span className="text-fg-2">{s.owner ? `Shared from ${s.owner.name}` : KIND_LABEL[s.kind]}</span> },
    { key: "state", header: "State", mobile: "meta", cell: (s) => <SourceStatusChip s={s} /> },
    { key: "complete", header: "Complete through", mobile: "meta", className: "md:max-xl:hidden", cell: (s) => {
      const lag = lagText(s);
      return <span className="grid"><span>{completeText(s)}</span>{lag && <span className="text-caption text-fg-3">{lag}</span>}</span>;
    } },
    { key: "rowsToday", header: "Records today", mobile: "meta", align: "right", className: "md:max-xl:hidden", cell: (s) => (s.rowsToday === null ? none : formatNumber(s.rowsToday)) },
    { key: "quarantinedToday", header: "Quarantined today", mobile: "meta", align: "right", className: "md:max-xl:hidden",
      cell: (s) => (s.quarantinedToday === null ? none : formatNumber(s.quarantinedToday)) },
  ];
}
