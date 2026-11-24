"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { BlockedButton, CategoryChip, type Column, ColumnsMenu, CopyValue, DataTable, FilterChecks, FilterLayout, FilterSearch, FilterSurface, Notice, Panel, RelativeTime, StatusChip, Toolbar } from "@starterkit/ui/ds";
import { formatNumber } from "@starterkit/ui/lib/format";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { ExportIcon, LogIcon } from "@starterkit/ui/ui/icons";
import { toast } from "@starterkit/ui/ui/toast";
import { CSV_MAX_ROWS } from "@starterkit/shared/audit";
import { Select } from "@starterkit/ui/ui/select";
import type { ActionRunRowDto } from "@starterkit/shared/contracts/breaks";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { PageHeader } from "@/components/shell/page-header";
import { errorText } from "@/lib/client/api";
import { useTableQuery } from "@/lib/client/use-table-query";
import { amountText } from "@/lib/shared/amount";
import { categoryChip } from "@/lib/shared/categories";
import { POSTING_FILTER, postingChip, postingEvent, postingPollMs } from "@/lib/shared/posting";
import { ACTION_RUNS, type PostingFilters } from "@/lib/shared/queries";

const LINK = "font-medium text-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const KIND_LABEL: Record<ActionRunRowDto["kind"], string> = { posting: "Posting", notify: "Notify" };
const FILTER_DEFAULTS: PostingFilters = { q: "", status: "", kind: "", show: "attention", recon: "", dateFrom: "", dateTo: "" };
const ATTENTION_LABEL = "Needs attention";
const FILTER_FIELDS = [{ key: "q", label: "Search" }, { key: "show", label: "Show", format: (v: string) => (v === "all" ? "All results" : ATTENTION_LABEL) },
  { key: "status", label: "Status" }, { key: "kind", label: "Kind" }] as const;

/**
 * The posting results' columns (audit §5.3): the item, its amount, the action (kind, connector, event), status, the
 * bank's answer and reference, when; hidden until chosen: which attempt it is and the recon. The connector shares the
 * action's cell, so seven show at 1440.
 */
/** Why Export CSV is blocked: no rows; under Needs attention the other results may still be there to export. */
export const exportBlockedText = (total: number, attention: boolean) =>
  total > 0 ? null : attention ? "Nothing needs attention; Show all to export every result." : "Nothing to export yet.";
export const postingColumns = (spaceId: string): Column<ActionRunRowDto>[] => [
  { key: "break", header: "Item", mobile: "title", className: "min-w-32", cell: (r) => (
    r.group
      ? <Link href={`/spaces/${encodeURIComponent(spaceId)}/recons/${encodeURIComponent(r.recon.id)}?tab=posting&group=${encodeURIComponent(r.group.id)}`} className={`text-body-sm ${LINK}`}>{r.group.items === 1 ? "Group of 1 item" : `Group of ${formatNumber(r.group.items)} items`}</Link>
      : r.break.id
      ? <Link href={`/spaces/${encodeURIComponent(spaceId)}/breaks/${encodeURIComponent(r.break.id)}`} className={`font-mono text-body-sm ${LINK}`}>{r.break.ref ?? "Unmatch item"}</Link>
      : <span className="font-mono text-body-sm text-fg">{r.break.ref ?? "The request"}</span>
  ) },
  { key: "amount", header: "Amount", mobile: "meta", align: "right", className: "whitespace-nowrap", cell: (r) => (r.amount
    ? <span className="tabular">{amountText(r.amount.minor, r.amount.currency)}{r.amount.currency ? <span className="ml-1 text-caption text-fg-3">{r.amount.currency}</span> : null}</span>
    : <span className="text-fg-3">—</span>) },
  { key: "action", header: "Action", mobile: "meta", cell: (r) => (
    <span className="grid justify-items-start gap-1">
      <span className="flex min-w-0 items-center gap-2"><span className="truncate">{r.action}</span><CategoryChip label={KIND_LABEL[r.kind]} slot={categoryChip("actionKind", r.kind)} /></span>
      <span className="text-caption text-fg-3">{[r.connector?.name, postingEvent(r)].filter(Boolean).join(" · ")}</span>
    </span>
  ) },
  { key: "status", header: "Status", mobile: "meta", hideable: false, cell: (r) => { const c = postingChip(r.status); return <StatusChip health={c.health} label={c.label} />; } },
  { key: "bank", header: "Bank answer", mobile: "meta", cell: (r) => <span className="grid"><span className="font-mono text-caption">{r.code ?? "—"}</span>{r.message && <span className="text-caption text-fg-3">{r.message}</span>}</span> },
  { key: "reference", header: "Bank reference", mobile: "hidden", className: "max-w-48", cell: (r) => (r.bankReference ? <CopyValue value={r.bankReference} label="bank reference" /> : <span className="text-fg-3">—</span>) },
  { key: "at", header: "When", mobile: "meta", className: "whitespace-nowrap", cell: (r) => <RelativeTime at={Date.parse(r.at)} /> },
  { key: "attempts", header: "Attempt", mobile: "meta", defaultHidden: true, align: "right", className: "whitespace-nowrap", cell: (r) => <span className="tabular">{formatNumber(r.attempts)}</span> },
  { key: "recon", header: "Recon", mobile: "meta", defaultHidden: true, className: "whitespace-nowrap", cell: (r) => r.recon.name },
];

/**
 * What the space's approvals sent to the bank (stage 4): each action run with its break, status and the bank's
 * answer, newest first; the ones that need someone first in the filter. A timeout's effect at the bank is unknown.
 */
export function PostingPage({ spaceId }: { spaceId: string }) {
  const def = useMemo(() => ACTION_RUNS(spaceId), [spaceId]);
  const COLUMNS = useMemo(() => postingColumns(spaceId), [spaceId]);
  const t = useTableQuery<ActionRunRowDto, PostingFilters>(def, true, (rows) => postingPollMs(rows.map((r) => r.status)));
  const [exporting, setExporting] = useState(false);
  const attention = t.state.show === "attention" && !t.state.status;
  const exportBlocked = t.total === undefined ? null : exportBlockedText(t.total, attention);
  async function exportCsv() {
    setExporting(true);
    try {
      const name = await (await import("@/lib/client/download")).download(`${def.path}?${t.filterQuery}&format=csv`, "posting.csv");
      toast(`Saved ${name}`, { description: `Every matching result, newest first, up to ${formatNumber(CSV_MAX_ROWS)} rows.` });
    } catch (e) {
      toast.error("Couldn't export the posting results", { description: errorText(e) });
    } finally {
      setExporting(false);
    }
  }
  return (
    <div className="grid gap-section">
      <PageHeader title="Posting" description="What approved changes sent to the bank and what it answered. Each posting is sent once; a failed one can be sent again from its item." />
      <FilterSurface>
        {t.staleError && <Notice tone="warn" live>Couldn&apos;t refresh the posting results; showing the ones loaded before. {errorText(t.staleError)}</Notice>}
        <FilterLayout busy={t.paging.busy} values={{ q: t.state.q, status: t.state.status, kind: t.state.kind, show: t.state.show }} defaults={FILTER_DEFAULTS} fields={FILTER_FIELDS} onApply={(values, options) => t.set(values, options)}
          filters={(draft, patch) => <>
            <FilterSearch label="Search posting results" value={draft.q} onChange={(q) => patch({ q })} placeholder="Reference, external ID or group key" />
            <FilterChecks label="Show" value={draft.show === "attention" ? "attention" : ""} options={[{ value: "attention", label: "Failed, timeout or not sent" }]} onChange={(v) => patch({ show: v ? "attention" : "all" })} />
            <FilterChecks label="Status" value={draft.status} options={POSTING_FILTER} onChange={(status) => patch({ status })} />
            <span className="grid gap-1.5">
              <span className="text-label text-fg">Kind</span>
              <Select aria-label="Kind" value={draft.kind} onChange={(e) => patch({ kind: e.target.value })}>
                <option value="">Every kind</option>{(["posting", "notify"] as const).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
              </Select>
            </span>
          </>}>
          {({ summary }) => (
            <Panel toolbar={<Toolbar end={<><SavedViewsMenu /><ColumnsMenu columns={COLUMNS} hidden={t.hidden} onChange={t.setHidden} />
              <BlockedButton variant="secondary" reason={exportBlocked} aria-disabled={exporting || undefined} onClick={() => { if (!exporting && !exportBlocked) void exportCsv(); }}>
                <Icon icon={ExportIcon} />{exporting ? "Exporting…" : "Export CSV"}
              </BlockedButton></>}>{null}</Toolbar>}
              flush icon={LogIcon} title={attention ? "Postings needing attention" : "All postings"}
              description={attention ? <>Failed, timeout or not sent <Button variant="link" size="sm" onClick={() => t.set({ show: "all" })}>Show all</Button></> : undefined} count={t.count}>
              {summary}
              <DataTable label="Posting results" columns={COLUMNS} hidden={t.hidden} rows={t.rows} rowKey={(r) => r.id} loading={t.loading}
                sort={t.sort} onSortChange={t.onSortChange} paging={t.paging}
                error={t.loadError ? { title: "Couldn't load the posting results", cause: errorText(t.loadError), onRetry: () => void t.query.refetch() } : null}
                empty={attention && !t.state.q && !t.state.kind
                  ? { icon: LogIcon, title: "Nothing needs attention", description: "A failed, timed out or unsent posting appears here. Show all results to see what was posted." }
                  : { icon: LogIcon, title: "Nothing sent yet", description: "A row appears when an approval runs an action of its recon, such as a posting to the bank." }} />
            </Panel>
          )}
        </FilterLayout>
      </FilterSurface>
    </div>
  );
}
