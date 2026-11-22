"use client";

import Link from "next/link";
import { type Column, RelativeTime, StatusChip, Truncate } from "@starterkit/ui/ds";
import { formatDate, formatNumber } from "@starterkit/ui/lib/format";
import type { LiveReconDto, LiveSourceDto, ReconRowDto } from "@starterkit/shared/contracts/recon";
import { reconStatus } from "@/lib/shared/recon-status";
import { Icon } from "@starterkit/ui/ui/icon";
import { SOURCE_KIND_WORD, sourceKindIcon, useElapsed } from "./live-hooks";
import { dayTotals, reconChip, sourceChip } from "./live-model";
import { rateText } from "./run-model";
import { reconHref } from "./use-recons";

const LINK = "font-medium text-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const none = <span className="text-fg-3">—</span>;

/**
 * "Version 2 · bifast-credit", with a version waiting after it ("· a new version in review"); before the first approval
 * the open version's state, as the chip says it: "Draft · code", "In review · code".
 */
export const reconCaption = (r: Pick<ReconRowDto, "publishedVersion" | "draftStatus" | "code">) =>
  r.publishedVersion
    ? [`Version ${r.publishedVersion}`, r.code, r.draftStatus === "in_review" ? "a new version in review" : r.draftStatus === "draft" ? "a new version drafted" : null].filter(Boolean).join(" · ")
    : `${r.draftStatus === "in_review" ? "In review" : "Draft"} · ${r.code}`;

/** What Today knows of the space (GET …/today): each live recon by id and the sources they read. */
export type LiveIndex = { recons: ReadonlyMap<string, LiveReconDto>; sources: ReadonlyMap<string, LiveSourceDto> };

/** The last run: running for how long (ticking), queued, or when the last scheduled one succeeded. */
function LastRun({ r }: { r: LiveReconDto }) {
  const elapsed = useElapsed(r.running?.status === "running" ? r.running.startedAt : null);
  if (r.running) return <span className="text-fg">{elapsed ? `Running for ${elapsed}` : "Queued"}</span>;
  return r.lastSuccessAt ? <RelativeTime at={Date.parse(r.lastSuccessAt)} touchDate={false} /> : <span className="text-fg-3">No run yet</span>;
}


/**
 * Columns of a space's recons (owner, 22 Nov: as the sources list, what an admin needs at a glance): the recon and its
 * version, the two sources it reads with their health, how often it runs, its current business date (state, match
 * rate, waiting) and its open breaks, its last run. The live columns come from Today (`live`; null while it loads, a
 * recon without an approved version has none). Name and created sort (RECON_SORTS).
 */
export function reconColumns(spaceId: string, live: LiveIndex | null): Column<ReconRowDto>[] {
  const of = (r: ReconRowDto) => live?.recons.get(r.id) ?? null;
  return [
    { key: "name", header: "Recon", sortable: true, mobile: "title", className: "min-w-56", cell: (r) => (
      <span className="grid min-w-0 max-w-80">
        <Truncate title={r.name}><Link href={reconHref(spaceId, r.id)} className={LINK}>{r.name}</Link></Truncate>
        <span className="truncate text-caption text-fg-3">{reconCaption(r)}</span>
      </span>
    ) },
    { key: "state", header: "State", mobile: "meta", cell: (r) => { const s = reconStatus(r); return <StatusChip health={s.health} label={s.label} />; } },
    { key: "sides", header: "Sources", mobile: "meta", className: "min-w-56", help: "The source each side reads, with its health; a source that is degraded or down holds the recon's day back.", cell: (r) => {
      const x = of(r);
      if (!x) return none;
      return (
        <span className="grid min-w-0 max-w-72 gap-0.5">
          {x.sides.map((side, i) => {
            const s = live?.sources.get(side.sourceId), chip = s ? sourceChip(s) : null;
            return (
              <span key={i} className="flex min-w-0 items-center gap-2 text-body-sm">
                <span className="w-3 shrink-0 text-caption text-fg-3">{i === 0 ? "A" : "B"}</span>
                {/* how its data arrives (owner, 22 Nov: a database apart from a file at a glance); the word for a screen reader */}
                {s && <span title={SOURCE_KIND_WORD[s.kind]} className="grid size-5 shrink-0 place-items-center rounded-sm bg-tray text-fg-2"><Icon icon={sourceKindIcon(s.kind)} size={12} /><span className="sr-only">{SOURCE_KIND_WORD[s.kind]}</span></span>}
                <span className="truncate text-fg" title={s?.name ?? side.label}>{s?.name ?? side.label}</span>
                {chip && chip.health !== "healthy" && <span className="shrink-0 text-caption text-degraded-ink">{chip.label}</span>}
              </span>
            );
          })}
        </span>
      );
    } },
    { key: "schedule", header: "Runs", mobile: "meta", className: "whitespace-nowrap md:max-xl:hidden", cell: (r) => {
      const s = of(r)?.schedule;
      return s ? (s.kind === "interval" ? `Every ${s.every_minutes} min` : `Daily at ${s.at}`) : none;
    } },
    { key: "today", header: "Business date", mobile: "meta", className: "whitespace-nowrap", help: "Its current business date (today for a recon that runs through the day, the last date due for a daily one) and where that day stands.", cell: (r) => {
      const x = of(r);
      if (!x) return none;
      const chip = reconChip(x, live!.sources);
      return (
        <span className="grid justify-items-start gap-1">
          <span>{formatDate(Date.parse(`${x.date}T00:00:00+07:00`))}</span>
          <StatusChip health={chip.health} label={chip.label} />
        </span>
      );
    } },
    { key: "lastRun", header: "Last run", mobile: "meta", className: "whitespace-nowrap md:max-xl:hidden", cell: (r) => { const x = of(r); return x ? <LastRun r={x} /> : none; } },
    { key: "rate", header: "Match rate", mobile: "meta", align: "right", className: "md:max-xl:hidden",
      help: "Side A items matched on its business date, of side A items in; suggested pairs count as not matched until accepted.", cell: (r) => {
      const x = of(r), rate = x ? (dayTotals(x)?.rate ?? null) : null;
      return rate === null ? none : <span className="tabular">{rateText(rate)}</span>;
    } },
    { key: "waiting", header: "Waiting", mobile: "meta", align: "right", className: "md:max-xl:hidden", help: "Items of its business date still without a counterpart, both sides; suggested pairs not accepted yet after them.", cell: (r) => {
      const t = of(r) ? dayTotals(of(r)!) : null;
      return !t ? none : (
        <span className="grid justify-items-end">
          <span className="tabular">{formatNumber(t.waiting)}</span>
          {t.suggested > 0 && <span className="text-caption text-fg-3 tabular">{formatNumber(t.suggested)} suggested</span>}
        </span>
      );
    } },
    { key: "breaks", header: "Unmatch", mobile: "meta", align: "right", help: "Unmatch items of every date not settled yet.", cell: (r) => {
      const x = of(r);
      return x ? <span className="tabular">{formatNumber(x.openBreaks)}</span> : none;
    } },
    { key: "createdAt", header: "Created", sortable: true, mobile: "meta", className: "whitespace-nowrap md:max-xl:hidden", cell: (r) => formatDate(Date.parse(r.createdAt)) },
  ];
}
