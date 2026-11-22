"use client";

import Link from "next/link";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Avatar, BlockedButton, type Column, ColumnsMenu, DataTable, Notice, Panel, RelativeTime, StatusChip, Toolbar, Truncate } from "@starterkit/ui/ds";
import type { Health } from "@starterkit/ui/lib/status";
import { formatMinor, formatNumber } from "@starterkit/ui/lib/format";
import { Input } from "@starterkit/ui/ui/input";
import { CURRENCY_EXPONENT } from "@starterkit/shared/sources";
import { Icon } from "@starterkit/ui/ui/icon";
import { ActivityIcon, AlertsIcon, BranchIcon, DiskIcon, LogIcon, RefreshIcon } from "@starterkit/ui/ui/icons";
import type { ActivityDto } from "@starterkit/shared/contracts/audit";
import type { QuarantineRowDto, SourceFileDto, SourceRecordDto, SourceSnapshotDto, SourceVersionRowDto } from "@starterkit/shared/contracts/sources";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { errorText } from "@/lib/client/api";
import { useTableQuery } from "@/lib/client/use-table-query";
import type { NoFilters, RecordFilters, TableDef, TrailFilters } from "@/lib/shared/queries";
import { sourceActivity, sourceFiles, sourceQuarantine, sourceRecords, sourceSnapshots, sourceVersions } from "@/lib/shared/queries";
import { VERSION_LEGEND, versionChip } from "@/lib/shared/source-status";
import { afterColon, at, day, fileResult, keptSnapshot } from "./source-text";
import { activitySentence, activityWhat } from "./spec-draft";
import { versionHref } from "./use-sources";

// The paged tables of a source's detail (Figma 95:8429, 27:7215, 96:8925): files, snapshots, quarantine, versions and
// activity, newest first,
// page and size in the URL. Each is a list in its own right: saved views and the column chooser like every list.

const none = <span className="text-fg-3">—</span>;
const mono = (text: string) => <span className="font-mono text-mono">{text}</span>;
type Chip = { health: Health; label: string; description: string };
const FILE_STATUS: Record<SourceFileDto["status"], Chip> = {
  ingested: { health: "healthy", label: "Ingested", description: "Read and stored; its quarantined rows are listed under Quarantine." },
  rejected: { health: "stopped", label: "Rejected", description: "The same content was ingested already; nothing changed." },
  failed: { health: "down", label: "Failed", description: "The file couldn't be read as declared; nothing of it was written." },
};
const SNAPSHOT_STATUS: Record<SourceSnapshotDto["status"], Chip> = {
  active: { health: "healthy", label: "Active", description: "The snapshot recons read for this business date." },
  failed: { health: "down", label: "Failed", description: "The pull stopped; the active snapshot of the date, if any, stayed as it was." },
  superseded: { health: "stopped", label: "Superseded", description: "Replaced by a newer pull of the same date; kept, never read." },
  loading: { health: "unknown", label: "Loading", description: "Being pulled; it becomes active only when the pull finishes." },
};
const legend = (m: Record<string, Chip>) => Object.values(m);
const chip = (c: Chip) => <StatusChip health={c.health} label={c.label} />;
/** The result cell: the chip and the line under it, wrapping in the column's width. */
const result = (c: Chip, line: string | null) => <span className="grid gap-1 justify-items-start whitespace-normal">{chip(c)}{line && <span className="text-caption text-fg-3">{line}</span>}</span>;
/** A cell whose text wraps in the column instead of running past the card. */
const WRAP = "whitespace-normal";

function Table<T, F extends NoFilters | TrailFilters = NoFilters>({ def, title, description, icon, legendItems, columns, rowKey, empty, rowActions, notice }: {
  def: TableDef<F>; title: string; description: string; icon: typeof DiskIcon; legendItems?: readonly Chip[];
  columns: (rows: readonly T[]) => Column<T>[]; rowKey: (r: T) => string; empty: { title: string; description: string };
  rowActions?: (r: T, rows: readonly T[]) => ReactNode; notice?: (rows: readonly T[]) => string | null;
}) {
  const t = useTableQuery<T, F>(def);
  const cols = columns(t.rows);
  const note = notice?.(t.rows) ?? null;
  return (
    <>
      {t.staleError && <Notice tone="warn" live>Couldn&apos;t refresh this list; showing the rows loaded before. {errorText(t.staleError)}</Notice>}
      {note && <Notice tone="warn">{note}</Notice>}
      <Panel toolbar={<Toolbar end={<><SavedViewsMenu /><ColumnsMenu columns={cols} hidden={t.hidden} onChange={t.setHidden} /></>}>{null}</Toolbar>}
        flush icon={icon} title={title} description={description} count={t.count} legend={legendItems}>
        <DataTable label={title} columns={cols} hidden={t.hidden} rows={t.rows} rowKey={rowKey} loading={t.loading} sort={t.sort} onSortChange={t.onSortChange} paging={t.paging}
          rowActions={rowActions ? (r) => rowActions(r, t.rows) : undefined}
          error={t.loadError ? { title: `Couldn't load ${title.toLowerCase()}`, cause: errorText(t.loadError), onRetry: () => void t.query.refetch() } : null}
          empty={{ icon, ...empty }} />
      </Panel>
    </>
  );
}

/** Files the inbox picked up (Figma 95:8429): a resend of the same content is listed as Rejected, never counted. */
/** A file's rows its source's conditions left out: what is neither a record nor quarantined. */
export const leftOut = (f: SourceFileDto) => Math.max(0, f.rowsTotal - f.rowsOk - f.rowsQuarantined);

export function FilesTable({ spaceId, id }: { spaceId: string; id: string }) {
  const def = useMemo(() => sourceFiles(spaceId, id), [spaceId, id]);
  return (
    <Table<SourceFileDto> def={def} title="Files" description="Newest first" icon={DiskIcon} legendItems={legend(FILE_STATUS)} rowKey={(f) => f.id}
      empty={{ title: "No files yet", description: "Files appear here once one matching the source's pattern lands in its folder and stops changing." }}
      columns={(rows) => [
        { key: "name", header: "File", mobile: "title", cell: (f) => mono(f.name) },
        { key: "businessDate", header: "Business date", mobile: "meta", cell: (f) => (f.businessDate ? day(f.businessDate) : none) },
        { key: "rowsTotal", header: "Rows", mobile: "meta", align: "right", cell: (f) => (f.status === "ingested" ? formatNumber(f.rowsTotal) : none) },
        // the records this file added (Figma 95:8429: a version 2 adds 2; the rest were stored already)
        { key: "rowsNew", header: "Records", mobile: "meta", align: "right", cell: (f) => (f.status === "ingested" ? formatNumber(f.rowsNew) : none) },
        { key: "rowsQuarantined", header: "Quarantined", mobile: "meta", align: "right", cell: (f) => (f.status === "ingested" ? formatNumber(f.rowsQuarantined) : none) },
        // rows the source's conditions left out (Rows to load): neither records nor quarantined, only in the total
        ...(rows.some((f) => leftOut(f) > 0) ? [{ key: "leftOut", header: "Left out", mobile: "meta" as const, align: "right" as const,
          help: "Rows the source's conditions (Rows to load) don't load: not stored and not quarantined.",
          cell: (f: SourceFileDto) => (f.status === "ingested" ? formatNumber(leftOut(f)) : none) }] : []),
        { key: "result", header: "Result", mobile: "meta", className: `${WRAP} min-w-64 w-full`, cell: (f) => result(FILE_STATUS[f.status], fileResult(f, rows.find((r) => r.id === f.versionOf))) },
      ]} />
  );
}

/** A record's amount in its currency ("IDR 1,500.50"), or as stored when its currency has no known decimals. */
const amountOf = (r: SourceRecordDto) => {
  if (r.amountMinor === null) return none;
  const exp = r.currency ? CURRENCY_EXPONENT[r.currency] : undefined;
  return <span className="font-mono text-mono tabular">{exp === undefined ? r.amountMinor : `${r.currency} ${formatMinor(BigInt(r.amountMinor), exp)}`}</span>;
};
const attrsText = (r: SourceRecordDto) => Object.entries(r.attrs).map(([k, v]) => `${k}=${v === null ? "∅" : String(v)}`).join(" · ");

/**
 * The Records tab (owner, 21 Nov: see and find what a source stored): the current records, newest business date first,
 * found by the start of a reference or account and kept to one date; each with its recon fields, where it came from
 * and its stored columns (all of them on hover, and on a phone's card).
 */
export function RecordsTable({ spaceId, id }: { spaceId: string; id: string }) {
  const def = useMemo(() => sourceRecords(spaceId, id), [spaceId, id]);
  const t = useTableQuery<SourceRecordDto, RecordFilters>(def);
  const [q, setQ] = useState(t.state.q);
  // the search applies a moment after typing stops, so each key isn't a query
  useEffect(() => {
    if (q === t.state.q) return;
    const h = setTimeout(() => t.set({ q } as Partial<typeof t.state>, { history: "replace" }), 300);
    return () => clearTimeout(h);
  }, [q, t]);
  const filtered = !!(t.state.q || t.state.businessDate);
  const cols: Column<SourceRecordDto>[] = [
    { key: "extRef", header: "Reference", mobile: "title", help: "The reference both sides share for the same transaction.", cell: (r) => (r.extRef ? mono(r.extRef) : none) },
    { key: "businessDate", header: "Business date", mobile: "meta", cell: (r) => day(r.businessDate) },
    { key: "amount", header: "Amount", mobile: "meta", align: "right", cell: amountOf },
    { key: "accountRef", header: "Account", mobile: "meta", cell: (r) => (r.accountRef ? mono(r.accountRef) : none) },
    { key: "origin", header: "From", mobile: "meta", help: "The file the record was read from, or a pull or a snapshot of the database.", cell: (r) => (r.origin.file ? mono(r.origin.file) : <span className="text-fg-2">{r.origin.kind === "pull" ? "Pull" : "Snapshot"}</span>) },
    { key: "attrs", header: "Stored columns", mobile: "meta", className: "max-w-96", help: "Every column kept with the record, under its stored name. Recons can match on any of them.",
      // one line, cut with an ellipsis (a table cell wraps a .truncate by default): every column is in the title
      cell: (r) => <span className="block max-w-96 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-mono text-fg-2" title={attrsText(r)}>{attrsText(r) || none}</span> },
  ];
  return (
    <>
      {t.staleError && <Notice tone="warn" live>Couldn&apos;t refresh the records; showing the ones loaded before. {errorText(t.staleError)}</Notice>}
      <Panel flush icon={DiskIcon} title="Records" description="The source's current records, newest business date first" count={t.count}
        toolbar={<Toolbar end={<><SavedViewsMenu /><ColumnsMenu columns={cols} hidden={t.hidden} onChange={t.setHidden} /></>}>
          <Input type="search" aria-label="Find a reference or account" placeholder="Reference or account starts with" className="w-full md:w-72 font-mono"
            value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" spellCheck={false} />
          <Input type="date" aria-label="Business date" className="w-full md:w-44" value={t.state.businessDate}
            onChange={(e) => t.set({ businessDate: e.target.value } as Partial<typeof t.state>)} />
        </Toolbar>}>
        <DataTable label="Records" columns={cols} hidden={t.hidden} rows={t.rows} rowKey={(r) => r.id} loading={t.loading} sort={t.sort} onSortChange={t.onSortChange} paging={t.paging}
          error={t.loadError ? { title: "Couldn't load records", cause: errorText(t.loadError), onRetry: () => void t.query.refetch() } : null}
          empty={filtered
            ? { icon: DiskIcon, title: "No record matches", description: "Change the reference, account or date, or clear them to see every record." }
            : { icon: DiskIcon, title: "No records yet", description: "Records appear here once the source's first file, pull or snapshot is read." }} />
      </Panel>
    </>
  );
}

/** Why "Pull <date> again" is off for a snapshot row, or null (Figma 27:7215, state d: a closed day needs a rerun request). */
export function pullAgainReason(row: SourceSnapshotDto, blocked: string | null): string | null {
  if (row.closed) return `Day ${day(row.businessDate)} is closed. Re-running it needs a rerun request (later release).`;
  return blocked;
}

/** The row action of a snapshot's date: pull it again (pending on the button; the result is a toast). */
export function PullAgain({ row, blocked, pending, onPull }: { row: SourceSnapshotDto; blocked: string | null; pending: boolean; onPull: (date: string) => void }) {
  return (
    <BlockedButton size="sm" variant="secondary" caption={false} reason={pullAgainReason(row, blocked)} disabled={pending} aria-busy={pending || undefined}
      onClick={() => onPull(row.businessDate)}><Icon icon={RefreshIcon} />Pull {day(row.businessDate)} again</BlockedButton>
  );
}

/**
 * Snapshots per business date (Figma 27:7215): one active per date, failed and superseded ones kept. A failed re-pull of
 * a date that still has its active snapshot says so above the table (state b). The newest row of each date offers
 * "Pull <date> again" (`run`); `blocked` = why the viewer can't (not a source admin, paused, a shared source: null run).
 */
export function SnapshotsTable({ spaceId, id, run }: {
  spaceId: string; id: string; run: { blocked: string | null; pending: boolean; onPull: (date: string) => void } | null;
}) {
  const def = useMemo(() => sourceSnapshots(spaceId, id), [spaceId, id]);
  return (
    <Table<SourceSnapshotDto> def={def} title="Snapshots" description="One active snapshot per business date; replaced ones are kept" icon={LogIcon}
      legendItems={legend(SNAPSHOT_STATUS)} rowKey={(x) => x.id} notice={keptSnapshot}
      empty={{ title: "No snapshots yet", description: "Snapshots appear here after the first scheduled pull, or after Pull now." }}
      rowActions={run ? (x, rows) => (rows.find((r) => r.businessDate === x.businessDate) === x ? <PullAgain row={x} {...run} /> : null) : undefined}
      columns={() => [
        { key: "businessDate", header: "Business date", mobile: "title", cell: (x) => <span className="font-medium text-fg">{day(x.businessDate)}</span> },
        { key: "startedAt", header: "Pulled", mobile: "meta", cell: (x) => (x.finishedAt
          ? `${at(x.startedAt)} · ${((Date.parse(x.finishedAt) - Date.parse(x.startedAt)) / 1000).toFixed(1)} s`
          : at(x.startedAt)) },
        { key: "rows", header: "Rows", mobile: "meta", align: "right", cell: (x) => formatNumber(x.rows) },
        { key: "status", header: "Snapshot", mobile: "meta", className: `${WRAP} min-w-56 max-w-sm`, cell: (x) => result(SNAPSHOT_STATUS[x.status], x.error) },
      ]} />
  );
}

/** "col: reason · col: reason"; a fault of the whole line (`_row`) is its reason alone. */
export const reasonsText = (r: Record<string, string>) => Object.entries(r).map(([k, v]) => (k === "_row" ? v : `${k}: ${afterColon(v)}`)).join(" · ");
/** The file a quarantined line came in, with its version ("bisettle20261118.txt · version 2"); a pull's line has none. */
const fileOf = (r: QuarantineRowDto) => (r.file ? `${r.file.name}${r.file.version ? ` · version ${r.file.version}` : ""}` : null);

/** Quarantined lines (Figma 96:8925), server-paged: the line, a reason per column, the raw line as it came. */
export function QuarantineTable({ spaceId, id }: { spaceId: string; id: string }) {
  const def = useMemo(() => sourceQuarantine(spaceId, id), [spaceId, id]);
  return (
    <>
      <Table<QuarantineRowDto> def={def} title="Quarantine" description="Newest first" icon={AlertsIcon} rowKey={(r) => r.id}
        empty={{ title: "No quarantined rows", description: "A row lands here when it can't become a record: a value of the wrong type, a required field empty or a column missing." }}
        columns={() => [
          { key: "line", header: "Row", mobile: "title", cell: (r) => <span className="font-medium text-fg">Row {formatNumber(r.line)}</span> },
          { key: "file", header: "File", mobile: "meta", cell: (r) => { const f = fileOf(r); return f ? mono(f) : <span className="text-fg-3">{r.origin === "pull" ? "Pull" : "Snapshot"}</span>; } },
          { key: "reasons", header: "Reason, per column", mobile: "meta", className: `${WRAP} min-w-56`, cell: (r) => <span className="text-fg">{reasonsText(r.reasons)}</span> },
          { key: "raw", header: "Raw line", mobile: "meta", className: `${WRAP} min-w-64`, cell: (r) => <span className="break-all font-mono text-mono">{r.raw}</span> },
          { key: "businessDate", header: "Business date", mobile: "meta", cell: (r) => (r.businessDate ? day(r.businessDate) : none) },
        ]} />
      <p className="text-caption text-fg-3">Quarantined rows never become unmatch items and can&apos;t be released by hand. To fix them, the sender sends a corrected file (a new file version, kept beside the old one), or a source admin changes the source in a new version.</p>
    </>
  );
}

const LINK = "font-medium text-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const who = (p: SourceVersionRowDto["maker"]) => (p ? (p.name ?? "A removed user") : null);

/** A source's versions (Versions tab), newest first, sortable by version or last change; each opens its version page. */
export function VersionsTable({ spaceId, id }: { spaceId: string; id: string }) {
  const def = useMemo(() => sourceVersions(spaceId, id), [spaceId, id]);
  return (
    <Table<SourceVersionRowDto> def={def} title="Versions" description="Every version of this source; a new one applies once a config checker approves it" icon={BranchIcon}
      legendItems={VERSION_LEGEND} rowKey={(v) => v.id}
      empty={{ title: "No versions yet", description: "A version appears here once a source admin or config maker starts one." }}
      columns={() => [
        { key: "version", header: "Version", sortable: true, mobile: "title", cell: (v) => <Link href={versionHref(spaceId, id, v.id)} className={LINK}>Version {v.version}</Link> },
        { key: "status", header: "State", mobile: "meta", cell: (v) => {
          const c = versionChip(v);
          const back = c.label === "Sent back" && v.checker ? `Sent back by ${who(v.checker)}` : null;
          return <span className="grid justify-items-start gap-1"><StatusChip health={c.health} label={c.label} />{back && <span className="text-caption text-fg-3">{back}</span>}</span>;
        } },
        { key: "maker", header: "Last edited by", mobile: "meta", cell: (v) => who(v.maker) ?? none },
        { key: "submitter", header: "Submitted by", mobile: "meta", cell: (v) => (v.submitter ? `${who(v.submitter)}${v.submittedAt ? ` · ${at(v.submittedAt)}` : ""}` : none) },
        { key: "checker", header: "Approved by", mobile: "meta", cell: (v) => (v.checker && v.publishedAt ? `${who(v.checker)} · ${at(v.publishedAt)}` : none) },
        { key: "updatedAt", header: "Changed", sortable: true, mobile: "meta", cell: (v) => at(v.updatedAt) },
      ]} />
  );
}

/** The source's own activity (Activity tab): who created it, set its connection, made and decided each version, shared it. */
export function ActivityTable({ spaceId, id }: { spaceId: string; id: string }) {
  const def = useMemo(() => sourceActivity(spaceId, id), [spaceId, id]);
  return (
    <Table<ActivityDto, TrailFilters> def={def} title="Activity" description="Newest first; the credential is never recorded" icon={ActivityIcon} rowKey={(e) => e.id}
      empty={{ title: "No activity yet", description: "Entries appear here when someone changes this source, its connection or a version." }}
      columns={() => [
        // as the activity log reads (time, user, what): the time on one line, the user with an avatar, then what they did
        { key: "at", header: "Time", mobile: "meta", className: "whitespace-nowrap", cell: (e) => (
          <span className="grid"><RelativeTime at={Date.parse(e.at)} touchDate={false} /><span className="font-mono text-caption text-fg-3">{at(e.at)}</span></span>
        ) },
        { key: "actor", header: "User", mobile: "meta", className: "min-w-48", cell: (e) => (
          <span className="flex min-w-0 max-w-56 items-center gap-2.5"><Avatar name={e.actor.name} seed={e.actor.id} /><Truncate title={e.actor.name}>{e.actor.name}</Truncate></span>
        ) },
        { key: "event", header: "What happened", mobile: "title", className: `${WRAP} wrap-anywhere md:min-w-80 w-full`, cell: (e) => <span className="text-fg">{activityWhat(e) ?? activitySentence(e)}</span> },
      ]} />
  );
}
