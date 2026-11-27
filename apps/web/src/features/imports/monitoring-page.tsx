"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useState } from "react";
import { EmptyState, Failure, Notice, Panel, RelativeTime, StatTile, StatTiles, StatusChip } from "@starterkit/ui/ds";
import { appDayStart, formatDate, formatDateTime, formatNumber, formatTime } from "@starterkit/ui/lib/format";
import { useDelayedFlag } from "@starterkit/ui/motion";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { ActivityIcon, AddIcon, AlertsIcon, CalendarIcon, RefreshIcon, SpinnerIcon, UploadIcon } from "@starterkit/ui/ui/icons";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@starterkit/ui/ui/table";
import { BRAND } from "@starterkit/shared/brand";
import type { ImportCellDto, ImportMonitorDto } from "@starterkit/shared/contracts/imports";
import { LoadingShape } from "@/components/route-skeleton";
import { PageHeader } from "@/components/shell/page-header";
import { ApiError, errorText } from "@/lib/client/api";
import { useAuth } from "@/lib/client/auth-context";
import { BAD_SCHEDULERS, DATE_LEGEND, dateChip, feedHref, SCHEDULER_LEGEND, schedulerChip } from "./import-model";
import { MONITORING_SHAPE } from "./shapes";
import { useMonitor } from "./use-imports";

/** Opened on a cell's click only: the dialog loads then, outside the page's first load. */
const DateDialog = dynamic(() => import("./date-dialog").then((m) => m.DateDialog), { ssr: false });

const HEAD = { title: "Monitoring", description: "Which dates each feed has loaded into staging, which are late or missing, and whether each scheduler runs." };
const day = (date: string) => formatDate(appDayStart(date));

/** Whether an error is the API's "staging isn't set up" (409 invalid_state): the page explains instead of failing. */
const notSetUp = (e: unknown) => e instanceof ApiError && e.code === "invalid_state";

export function MonitoringPage() {
  const q = useMonitor();
  const skeleton = useDelayedFlag(!q.data && !q.error);
  const refreshing = useDelayedFlag(q.isFetching && !!q.data);
  if (q.error && !q.data) {
    return <div className="grid gap-section">
      <PageHeader {...HEAD} />
      <Panel>
        {notSetUp(q.error)
          ? <EmptyState icon={ActivityIcon} title="Staging isn't set up" description={`${errorText(q.error)} Monitoring appears once the API and the worker have the staging database.`} />
          : <Failure title="Couldn't load monitoring" error={q.error} source={BRAND.name} onRetry={() => void q.refetch()} />}
      </Panel>
    </div>;
  }
  if (!q.data || skeleton) return <LoadingShape sections={MONITORING_SHAPE} shown={skeleton} />;
  return <Monitor m={q.data} stale={q.error} refreshing={refreshing} onRefresh={() => void q.refetch()} fetching={q.isFetching} />;
}

function Monitor({ m, stale, refreshing, fetching, onRefresh }: { m: ImportMonitorDto; stale: unknown; refreshing: boolean; fetching: boolean; onRefresh: () => void }) {
  const { can } = useAuth();
  const [open, setOpen] = useState<{ feedId: string; feedName: string; date: string } | null>(null);
  const newest = m.dates.at(-1)!;
  const badSchedulers = m.feeds.filter((f) => BAD_SCHEDULERS.includes(f.scheduler.state)).length;
  const anyOn = m.feeds.some((f) => f.schedulerOn);
  const refresh = (
    <Button type="button" variant="secondary" disabled={fetching} aria-busy={refreshing || undefined} onClick={onRefresh}>
      <Icon icon={refreshing ? SpinnerIcon : RefreshIcon} className={refreshing ? "motion-safe:animate-spin" : undefined} />Refresh
    </Button>
  );
  return (
    <div className="grid gap-section">
      <PageHeader {...HEAD} actions={refresh} />
      {stale ? <Notice tone="warn" live>Couldn&apos;t refresh monitoring; showing what was loaded {formatTime(Date.parse(m.now))}. {errorText(stale)}</Notice> : null}
      {!m.workerAlive && anyOn && (
        <Notice tone="warn" live>The worker hasn&apos;t written its minute for over 3 minutes, so no scheduled run can start. Check that the worker is running.</Notice>
      )}
      {m.feeds.length === 0 ? (
        <Panel>
          <EmptyState icon={UploadIcon} title="No feeds yet" description="Feeds appear here after you add one, with their dates and their scheduler."
            action={can("import.manage") ? <Button variant="create-solid" asChild><Link href="/imports/feeds/new"><Icon icon={AddIcon} />Add feed</Link></Button> : undefined} />
        </Panel>
      ) : <>
        <StatTiles>
          <StatTile icon={AlertsIcon} label="Missing" value={formatNumber(m.today.missing)} caption={`MIS date ${day(newest)}`} />
          <StatTile icon={AlertsIcon} label="Failed" value={formatNumber(m.today.failed)} caption={`MIS date ${day(newest)}`} />
          <StatTile icon={CalendarIcon} label="Late" value={formatNumber(m.today.late)} caption={`MIS date ${day(newest)}`} />
          <StatTile icon={CalendarIcon} label="Imported" value={formatNumber(m.today.imported)} caption={`of ${formatNumber(m.feeds.length)} feeds`} />
          <StatTile icon={ActivityIcon} label="Schedulers with an issue" value={formatNumber(badSchedulers)} caption={`of ${formatNumber(m.feeds.length)} feeds`} />
        </StatTiles>
        <Schedulers m={m} />
        <DateGrid m={m} onOpen={setOpen} />
      </>}
      {open && <DateDialog feedId={open.feedId} feedName={open.feedName} date={open.date} onClose={() => setOpen(null)} />}
    </div>
  );
}

function Schedulers({ m }: { m: ImportMonitorDto }) {
  return (
    <Panel flush icon={ActivityIcon} title="Schedulers" count={m.feeds.length} legend={SCHEDULER_LEGEND}>
      <div className="scroll-quiet overflow-x-auto">
        <Table aria-label="Schedulers">
          <TableHeader>
            <TableRow><TableHead>Feed</TableHead><TableHead>Scheduler</TableHead><TableHead>Last run</TableHead><TableHead>Next run</TableHead><TableHead>Note</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {m.feeds.map((f) => {
              const chip = schedulerChip(f.scheduler.state);
              const last = f.scheduler.lastRun;
              return (
                <TableRow key={f.id}>
                  <TableCell><Link href={feedHref(f.id)} className="font-medium text-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">{f.name}</Link></TableCell>
                  <TableCell><StatusChip health={chip.health} label={chip.label} /></TableCell>
                  <TableCell>{last ? <span className="grid"><RelativeTime at={Date.parse(last.startedAt)} /><span className="text-caption text-fg-3">{last.trigger === "manual" ? "Started by hand" : "Scheduled"}, {last.status}</span></span> : <span className="text-fg-3">No run yet</span>}</TableCell>
                  <TableCell>{f.scheduler.nextRun ? formatDateTime(Date.parse(f.scheduler.nextRun)) : <span className="text-fg-3">–</span>}</TableCell>
                  <TableCell className="max-w-96 whitespace-normal text-body-sm text-fg-2">{f.scheduler.message ?? <span className="text-fg-3">–</span>}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </Panel>
  );
}

/** A cell's second line: rows loaded and when, or when it was last looked at. */
function cellNote(c: ImportCellDto): string | null {
  if (c.rows !== null && c.at) return `${formatNumber(c.rows)} rows, ${formatTime(Date.parse(c.at))}`;
  if (c.at) return formatTime(Date.parse(c.at));
  return null;
}

function DateGrid({ m, onOpen }: { m: ImportMonitorDto; onOpen: (o: { feedId: string; feedName: string; date: string }) => void }) {
  const dates = [...m.dates].reverse(); // newest first
  return (
    <Panel flush icon={CalendarIcon} title="Dates" description="Newest MIS date first. Open a date for its checks and history." legend={DATE_LEGEND}>
      <div className="scroll-quiet overflow-x-auto">
        <Table aria-label="Dates by feed">
          <TableHeader>
            <TableRow><TableHead className="sticky left-0 bg-card">MIS date</TableHead>{m.feeds.map((f) => <TableHead key={f.id}>{f.name}</TableHead>)}</TableRow>
          </TableHeader>
          <TableBody>
            {dates.map((d) => (
              <TableRow key={d}>
                <TableCell className="sticky left-0 bg-card whitespace-nowrap">{day(d)}</TableCell>
                {m.feeds.map((f) => {
                  const c = f.cells.find((x) => x.date === d);
                  if (!c) return <TableCell key={f.id}><span className="text-fg-3">Before start</span></TableCell>;
                  const chip = dateChip(c.state);
                  const note = cellNote(c);
                  return (
                    <TableCell key={f.id} className="p-1">
                      <button type="button" onClick={() => onOpen({ feedId: f.id, feedName: f.name, date: d })}
                        aria-label={`${f.name}, ${day(d)}: ${chip.label}${note ? `, ${note}` : ""}. Open the date.`}
                        className="grid w-full min-w-36 justify-items-start gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-tray focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
                        <StatusChip health={chip.health} label={chip.label} interactive={false} />
                        {note && <span className="text-caption text-fg-3">{note}</span>}
                      </button>
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Panel>
  );
}

