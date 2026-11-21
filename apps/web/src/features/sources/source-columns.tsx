import Link from "next/link";
import { CategoryChip, type CategorySlot, type Column, StatusChip, Truncate } from "@starterkit/ui/ds";
import { formatNumber } from "@starterkit/ui/lib/format";
import type { SourceRowDto } from "@starterkit/shared/contracts/sources";
import { sourceStatus } from "@/lib/shared/source-status";
import { completeText, KIND_LABEL, lagText, withDays } from "./source-text";
import { sourceHref } from "./use-sources";

const LINK = "font-medium text-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const none = <span className="text-fg-3">—</span>;
/**
 * The kind chip's hue says how data arrives: a file (blue) or a database (violet); the label says the mode. Slots 2, 3
 * and 5 (orange, teal, ochre) are left out: beside the state chip they read as Degraded or Healthy.
 */
const KIND_SLOT: Record<SourceRowDto["kind"], CategorySlot> = { file_inbox: 1, db_watermark: 4, db_snapshot: 4 };

/** A source's state chip with the API's reason (or last error) as its description. */
export function SourceStatusChip({ s }: { s: SourceRowDto }) {
  const st = sourceStatus(s);
  const why = s.health?.reason ?? s.health?.lastError ?? null;
  return <StatusChip strong health={st.health} label={st.label} description={why ? withDays(why) : null} />;
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
    // KIND_SLOT per kind, the same in every row (Figma 02 v1.0.6); a shared source neutral
    { key: "kind", header: "Kind", mobile: "meta", cell: (s) => <CategoryChip slot={s.owner ? "neutral" : KIND_SLOT[s.kind]} label={s.owner ? `Shared from ${s.owner.name}` : KIND_LABEL[s.kind]} /> },
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
