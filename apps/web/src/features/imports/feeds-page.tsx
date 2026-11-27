"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ActionMenu, type Column, ColumnsMenu, DataTable, FilterLayout, FilterSearch, FilterSurface, Notice, Panel, RelativeTime, StatusChip, Toolbar, Truncate } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { Icon } from "@starterkit/ui/ui/icon";
import { AddIcon, UploadIcon } from "@starterkit/ui/ui/icons";
import type { ImportFeedRowDto } from "@starterkit/shared/contracts/imports";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { PageHeader } from "@/components/shell/page-header";
import { errorText } from "@/lib/client/api";
import { useAuth } from "@/lib/client/auth-context";
import { useTableQuery } from "@/lib/client/use-table-query";
import { statusChips } from "@/lib/shared/categories";
import { IMPORT_FEEDS, type ImportFeedFilters } from "@/lib/shared/queries";
import { feedHref } from "./import-model";
import { IssuesNotice } from "./issues-notice";

const LINK = "font-medium text-fg hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary";
const schedulerOnOff = statusChips<"on" | "off">({ on: ["on", "On"], off: ["off", "Off"] });
const LEGEND = [
  { ...schedulerOnOff("on"), description: "Runs on its own at its run times." },
  { ...schedulerOnOff("off"), description: "Runs only when started by hand. Its dates are still watched in Monitoring." },
];
const FILTER_DEFAULTS: ImportFeedFilters = { q: "" };
const FILTER_FIELDS = [{ key: "q", label: "Search" }] as const;

const COLUMNS: Column<ImportFeedRowDto>[] = [
  { key: "name", header: "Feed", sortable: true, mobile: "title", className: "min-w-48", cell: (f) => (
    <span className="grid min-w-0 max-w-96">
      <Truncate title={f.name}><Link href={feedHref(f.id)} className={LINK}>{f.name}</Link></Truncate>
      <span className="truncate font-mono text-caption text-fg-3">{f.historySource}</span>
    </span>
  ) },
  { key: "table", header: "Target table", mobile: "meta", cell: (f) => (f.table ? <span className="font-mono text-body-sm">{f.table}</span> : <span className="text-fg-3">Not set</span>) },
  { key: "scheduler", header: "Scheduler", hideable: false, mobile: "meta", cell: (f) => <StatusChip {...schedulerOnOff(f.schedulerOn ? "on" : "off")} /> },
  { key: "runTimes", header: "Run times", mobile: "meta", cell: (f) => (f.runTimes.length ? f.runTimes.join(", ") : <span className="text-fg-3">Not set</span>) },
  { key: "setup", header: "Setup", mobile: "meta", cell: (f) => (f.complete ? "Complete" : <span className="text-fg-3">Watch only</span>) },
  { key: "updatedAt", header: "Updated", sortable: true, mobile: "hidden", cell: (f) => <RelativeTime at={Date.parse(f.updatedAt)} /> },
];

export function FeedsPage() {
  const { can } = useAuth();
  const router = useRouter();
  const t = useTableQuery<ImportFeedRowDto, ImportFeedFilters>(IMPORT_FEEDS);
  const filtered = t.state.q !== "";
  return (
    <div className="grid gap-section">
      <PageHeader title="Feeds" description="Every import feed: where it loads, its history source and whether it runs on its own."
        actions={can("import.manage") ? <Button variant="create-solid" asChild><Link href="/imports/feeds/new"><Icon icon={AddIcon} />Add feed</Link></Button> : undefined} />
      <IssuesNotice />
      <FilterSurface>
      {t.staleError && <Notice tone="warn" live>Couldn&apos;t refresh the feeds; showing the ones loaded before. {errorText(t.staleError)}</Notice>}
      <FilterLayout<ImportFeedFilters> busy={t.paging.busy} values={{ q: t.state.q }} defaults={FILTER_DEFAULTS} fields={FILTER_FIELDS}
        onApply={(values, options) => t.set(values, options)} filters={(draft, patch) => <FilterSearch label="Search feeds" value={draft.q} onChange={(q) => patch({ q })} placeholder="Feed name" />}>
      {({ summary }) => <Panel toolbar={<Toolbar end={<><SavedViewsMenu /><ColumnsMenu columns={COLUMNS} hidden={t.hidden} onChange={t.setHidden} /></>}>{null}</Toolbar>}
        flush icon={UploadIcon} title="All feeds" count={t.count} legend={LEGEND}>
        {summary}
        <DataTable label="Feeds" rowHeight="identity" columns={COLUMNS} hidden={t.hidden} rows={t.rows} rowKey={(f) => f.id} loading={t.loading}
          sort={t.sort} onSortChange={t.onSortChange} paging={t.paging}
          error={t.loadError ? { title: "Couldn't load feeds", cause: errorText(t.loadError), onRetry: () => void t.query.refetch() } : null}
          empty={filtered
            ? { icon: UploadIcon, title: "No feeds match", description: "Change the search, or clear it to see every feed." }
            : { icon: UploadIcon, title: "No feeds yet", description: "Feeds appear here after you add one." }}
          rowActions={(f) => <ActionMenu label={`Actions for ${f.name}`} actions={[{ id: "open", label: "Open feed", onSelect: () => router.push(feedHref(f.id)) }]} />} />
      </Panel>}
      </FilterLayout>
      </FilterSurface>
    </div>
  );
}
