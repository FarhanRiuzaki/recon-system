import Link from "next/link";
import { CategoryChip, type Column, RelativeTime, Truncate } from "@starterkit/ui/ds";
import { Sparkline } from "@starterkit/ui/charts";
import { formatNumber, formatTime } from "@starterkit/ui/lib/format";
import type { SourceRowDto } from "@starterkit/shared/contracts/sources";
import { completeText, KIND_LABEL, lagText, withDays } from "./source-text";
import { SourceStatusChip } from "./source-status-chip";
import { sourceHref } from "./use-sources";

const LINK = "font-medium text-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const none = <span className="text-fg-3">—</span>;
/** One line cut with an ellipsis (a table cell wraps `.truncate` on purpose, so it is spelled out); the title holds it all. */
const ONE_LINE = "block max-w-full overflow-hidden text-ellipsis whitespace-nowrap font-mono text-caption";

/**
 * What the last pull brought: "+4 rows" (in the good-delta green, as a StatTile's pill: rows came in) then "1 left out",
 * "1 quarantined"; or "Nothing new", "Paused", "The last pull failed".
 */
function PullText({ p }: { p: NonNullable<SourceRowDto["lastPull"]> }) {
  if (p.status !== "new") return <>{p.status === "nothing_new" ? "Nothing new" : p.status === "paused" ? "Paused" : "The last pull failed"}</>;
  const rest = [p.leftOut ? `${formatNumber(p.leftOut)} left out` : "", p.quarantined ? `${formatNumber(p.quarantined)} quarantined` : ""].filter(Boolean);
  return (
    <>
      <span className={p.added ? "text-healthy-ink" : undefined}>+{formatNumber(p.added)} {p.added === 1 ? "row" : "rows"}</span>
      {rest.length > 0 && ` · ${rest.join(" · ")}`}
    </>
  );
}


/** "Version 1 · bi-settlement · version 2 in review", "Draft · code", or, through a share, who owns it. */
export const sourceCaption = (s: SourceRowDto) =>
  s.owner ? `Read-only here · owned by ${s.owner.name}` : [
    s.publishedVersion ? `Version ${s.publishedVersion}` : "Draft", s.code,
    s.pending && s.publishedVersion ? `version ${s.pending.version} ${s.pending.status === "in_review" ? "in review" : "drafted"}` : null,
  ].filter(Boolean).join(" · ");
const ENGINE: Record<NonNullable<SourceRowDto["engine"]>, string> = { postgres: "PostgreSQL", mysql: "MySQL", mssql: "SQL Server", oracle: "Oracle" };

/**
 * Columns of a space's sources (audit §5.5): source, kind and engine chips, state, complete through, last read (what
 * the last pull brought in fg-2), records today with its week, used by; what it reads and where hidden until chosen.
 * Phone card: the source is the title, the rest lines under it. Tablet (768–1279) shows Kind and State only. Name and
 * created sort (the API's SOURCE_SORTS).
 */
export function sourceColumns(spaceId: string): Column<SourceRowDto>[] {
  return [
    { key: "name", header: "Source", sortable: true, mobile: "title", className: "min-w-56", cell: (s) => (
      <span className="grid min-w-0 max-w-80">
        <Truncate title={s.name}><Link href={sourceHref(spaceId, s.id)} className={LINK}>{s.name}</Link></Truncate>
        <span className="truncate text-caption text-fg-3">{sourceCaption(s)}</span>
      </span>
    ) },
    // kind (with its read mode) and engine as neutral chips: facts, not states (audit §1.1); a shared source names its owner
    { key: "kind", header: "Kind", mobile: "meta", cell: (s) => (
      <span className="flex max-w-56 flex-wrap gap-1">
        <CategoryChip slot="neutral" label={s.owner ? `Shared from ${s.owner.name}` : KIND_LABEL[s.kind]} />
        {!s.owner && s.engine && <CategoryChip slot="neutral" label={ENGINE[s.engine]} />}
      </span>
    ) },
    // what it reads and where (owner, 21 Nov: the table or folder, and the server for a source admin); hidden until chosen (audit §5.5)
    { key: "reads", header: "Reads", mobile: "meta", defaultHidden: true, className: "min-w-48", cell: (s) => (
      !s.reads && !s.server ? none : (
        <span className="grid min-w-0 max-w-80">
          {s.reads && <span className={`${ONE_LINE} text-fg-2`} title={s.reads}>{s.reads}</span>}
          {s.server && <span className={`${ONE_LINE} text-fg-3`} title={s.server}>{s.server}</span>}
        </span>
      )
    ) },
    // the reason in the cell, not only in the chip's tooltip (owner, 22 Nov: why it needs attention at a glance)
    { key: "state", header: "State", mobile: "meta", cell: (s) => {
      const why = s.status === "paused" ? null : s.health && s.health.state !== "healthy" ? (s.health.reason ?? s.health.lastError) : null;
      return (
        <span className="grid max-w-56 justify-items-start gap-1">
          <SourceStatusChip s={s} />
          {why && <span className="line-clamp-2 text-caption text-fg-3" title={withDays(why)}>{withDays(why)}</span>}
        </span>
      );
    } },
    { key: "complete", header: "Complete through", mobile: "meta", className: "md:max-xl:hidden", cell: (s) => {
      const lag = lagText(s);
      return <span className="grid whitespace-nowrap"><span>{completeText(s)}</span>{lag && <span className="text-caption text-fg-3">{lag}</span>}</span>;
    } },
    { key: "lastRead", header: "Last read", mobile: "meta", className: "md:max-xl:hidden",
      help: "The last read that succeeded, what the last pull brought (rows added, rows the source's conditions left out) and when it reads next.", cell: (s) => (
      !s.health ? none : (
        <span className="grid max-w-64 whitespace-nowrap">
          {s.health.lastReadAt ? <RelativeTime at={Date.parse(s.health.lastReadAt)} touchDate={false} /> : <span className="text-fg-3">Not yet</span>}
          {s.health.lastError ? <span className="line-clamp-2 text-caption text-down-ink" title={s.health.lastError}>{s.health.lastError}</span>
            : s.lastPull && <span className="text-caption text-fg-2"><PullText p={s.lastPull} /></span>}
          {s.nextRunAt && <span className="text-caption text-fg-3">Next read {formatTime(Date.parse(s.nextRunAt))}</span>}
        </span>
      )
    ) },
    // the day's count with its week (owner, 22 Nov: a drop shows before the state does) and its quarantined lines
    { key: "rowsToday", header: "Records today", mobile: "meta", align: "right", className: "md:max-xl:hidden",
      help: "Records for the business date its health counts, the 7 dates up to it, the day before and lines quarantined that date.", cell: (s) => (
      s.rowsToday === null ? none : (
        <span className="ml-auto grid w-28 justify-items-end gap-1">
          <span className="tabular">{formatNumber(s.rowsToday)}</span>
          {s.recent.some((n) => n > 0) && <span className="block w-full"><Sparkline values={s.recent} height={20} /></span>}
          <span className="text-caption text-fg-3 tabular">
            {s.recent.length > 1 ? `${formatNumber(s.recent.at(-2)!)} the day before` : ""}
            {s.quarantinedToday ? `${s.recent.length > 1 ? " · " : ""}${formatNumber(s.quarantinedToday)} quarantined` : ""}
          </span>
        </span>
      )
    ) },
    { key: "usedBy", header: "Used by", mobile: "meta", align: "right", className: "md:max-xl:hidden", help: "How many approved recons read this source.",
      cell: (s) => (s.usedByCount ? `${formatNumber(s.usedByCount)} ${s.usedByCount === 1 ? "recon" : "recons"}` : none) },
  ];
}
