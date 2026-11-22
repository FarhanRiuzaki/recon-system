"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { BlockedButton, CategoryChip, type Column, ColumnsMenu, DataTable, FilterChecks, FilterLayout, FilterSearch, FilterSurface, Notice, Panel, RelativeTime, StatusChip, Toolbar } from "@starterkit/ui/ds";
import { formatNumber } from "@starterkit/ui/lib/format";
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
import { categoryChip } from "@/lib/shared/categories";
import { POSTING_FILTER, postingChip, postingEvent } from "@/lib/shared/posting";
import { ACTION_RUNS, type PostingFilters } from "@/lib/shared/queries";

const LINK = "font-medium text-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const KIND_LABEL: Record<ActionRunRowDto["kind"], string> = { posting: "Posting", notify: "Notify" };
const FILTER_DEFAULTS: PostingFilters = { q: "", status: "", kind: "" };
const FILTER_FIELDS = [{ key: "q", label: "Search" }, { key: "status", label: "Status" }, { key: "kind", label: "Kind" }] as const;

const columns = (spaceId: string): Column<ActionRunRowDto>[] => [
  { key: "break", header: "Item", mobile: "title", className: "min-w-40", cell: (r) => (
    <span className="grid min-w-0">
      {r.break.id ? <Link href={`/spaces/${encodeURIComponent(spaceId)}/breaks/${encodeURIComponent(r.break.id)}`} className={LINK}>{r.break.ref ?? "Break"}</Link> : <span className="text-fg">{r.break.ref ?? "The request"}</span>}
      <span className="text-caption text-fg-3">{r.recon.name}</span>
    </span>
  ) },
  { key: "action", header: "Action", mobile: "meta", cell: (r) => (
    <span className="grid justify-items-start gap-1">
      <span className="flex min-w-0 items-center gap-2"><span className="truncate">{r.action}</span><CategoryChip label={KIND_LABEL[r.kind]} slot={categoryChip("actionKind", r.kind)} /></span>
      <span className="text-caption text-fg-3">{postingEvent(r)}</span>
    </span>
  ) },
  { key: "status", header: "Status", mobile: "meta", hideable: false, cell: (r) => { const c = postingChip(r.status); return <StatusChip health={c.health} label={c.label} />; } },
  { key: "bank", header: "Bank answer", mobile: "meta", cell: (r) => <span className="grid"><span className="font-mono text-caption">{r.code ?? "—"}</span>{r.message && <span className="text-caption text-fg-3">{r.message}</span>}</span> },
  { key: "reference", header: "Bank reference", mobile: "hidden", className: "whitespace-nowrap", cell: (r) => <span className="font-mono text-caption">{r.bankReference ?? "—"}</span> },
  { key: "at", header: "When", mobile: "meta", className: "whitespace-nowrap", cell: (r) => <RelativeTime at={Date.parse(r.at)} /> },
];

/**
 * What the space's approvals sent to the bank (stage 4): each action run with its break, status and the bank's
 * answer, newest first; the ones that need someone first in the filter. A timeout's effect at the bank is unknown.
 */
export function PostingPage({ spaceId, spaceName }: { spaceId: string; spaceName: string }) {
  const def = useMemo(() => ACTION_RUNS(spaceId), [spaceId]);
  const COLUMNS = useMemo(() => columns(spaceId), [spaceId]);
  const t = useTableQuery<ActionRunRowDto, PostingFilters>(def);
  const [exporting, setExporting] = useState(false);
  const exportBlocked = t.total === 0 ? "No posting result matches, so there is nothing to export." : null;
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
      <PageHeader title="Posting" description="What approvals sent to the bank, and what the bank answered. Recon never sends a posting twice." />
      <FilterSurface>
        {t.staleError && <Notice tone="warn" live>Couldn&apos;t refresh the posting results; showing the ones loaded before. {errorText(t.staleError)}</Notice>}
        <FilterLayout busy={t.paging.busy} values={{ q: t.state.q, status: t.state.status, kind: t.state.kind }} defaults={FILTER_DEFAULTS} fields={FILTER_FIELDS} onApply={(values, options) => t.set(values, options)}
          filters={(draft, patch) => <>
            <FilterSearch label="Search posting results" value={draft.q} onChange={(q) => patch({ q })} placeholder="Reference or external ID" />
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
              flush icon={LogIcon} title={`Posting in ${spaceName}`} count={t.count}>
              {summary}
              <DataTable label="Posting results" columns={COLUMNS} hidden={t.hidden} rows={t.rows} rowKey={(r) => r.id} loading={t.loading}
                sort={t.sort} onSortChange={t.onSortChange} paging={t.paging}
                error={t.loadError ? { title: "Couldn't load the posting results", cause: errorText(t.loadError), onRetry: () => void t.query.refetch() } : null}
                empty={{ icon: LogIcon, title: "Nothing sent yet", description: "A row appears when an approval runs an action of its recon, such as a posting to the bank." }} />
            </Panel>
          )}
        </FilterLayout>
      </FilterSurface>
    </div>
  );
}
