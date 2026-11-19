"use client";

import { useMemo } from "react";
import { ColumnsMenu, DataTable, FilterLayout, FilterSearch, FilterSurface, Notice, Panel, Toolbar } from "@starterkit/ui/ds";
import { DiskIcon } from "@starterkit/ui/ui/icons";
import type { SourceRowDto } from "@starterkit/shared/contracts/sources";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { PageHeader } from "@/components/shell/page-header";
import { errorText } from "@/lib/client/api";
import { useTableQuery } from "@/lib/client/use-table-query";
import { SOURCES } from "@/lib/shared/queries";
import { SOURCE_LEGEND } from "@/lib/shared/source-status";
import { sourceColumns } from "./source-columns";

const FILTER_DEFAULTS = { q: "" };
const FILTER_FIELDS = [{ key: "q", label: "Search" }] as const;

/**
 * A space's sources (Figma 17:5543 / 31:8132): its own and those shared to it, each with the health the API judged for
 * the business date in progress (page.tsx has checked the viewer holds a role in the space and prefetched the first
 * page). New source arrives with the wizard (Task 7).
 */
export function SourcesPage({ spaceId, spaceName }: { spaceId: string; spaceName: string }) {
  const def = useMemo(() => SOURCES(spaceId), [spaceId]);
  const columns = useMemo(() => sourceColumns(spaceId), [spaceId]);
  const t = useTableQuery<SourceRowDto, { q: string }>(def);
  return (
    <div className="grid gap-section">
      <PageHeader title="Sources"
        description="Each source is stored once and read by every recon in this space. Source admins set up connections; field mapping can be finished by a source admin or a config maker. Every new version needs approval." />
      <FilterSurface>
      {t.staleError && <Notice tone="warn" live>Couldn&apos;t refresh the sources; showing the ones loaded before. {errorText(t.staleError)}</Notice>}
      {t.viewNotRemembered && <Notice>This filter selection works at this URL, but is too long to remember in navigation. Save a named view to reopen it.</Notice>}
      <FilterLayout busy={t.paging.busy} values={{ q: t.state.q }} defaults={FILTER_DEFAULTS} fields={FILTER_FIELDS}
        onApply={(values, options) => t.set(values, options)} filters={(draft, patch) =>
          <FilterSearch label="Search sources" value={draft.q} onChange={q => patch({ q })} placeholder="Name or code" />}>
      {({ summary }) => <Panel toolbar={<Toolbar end={<><SavedViewsMenu /><ColumnsMenu columns={columns} hidden={t.hidden} onChange={t.setHidden} /></>}>{null}</Toolbar>}
        flush icon={DiskIcon} title={`Sources in ${spaceName}`} count={t.count} legend={SOURCE_LEGEND}>
        {summary}
        <DataTable label="Sources" rowHeight="identity" columns={columns} hidden={t.hidden} rows={t.rows} rowKey={(s) => s.id} loading={t.loading}
          sort={t.sort} onSortChange={t.onSortChange} paging={t.paging}
          error={t.loadError ? { title: "Couldn't load sources", cause: errorText(t.loadError), onRetry: () => void t.query.refetch() } : null}
          empty={t.state.q
            ? { icon: DiskIcon, title: "No sources match", description: "Change the search, or clear it to see every source." }
            : { icon: DiskIcon, title: "No sources yet", description: "Sources appear here once a source admin adds one, or another space shares one with this space." }} />
      </Panel>}
      </FilterLayout>
      </FilterSurface>
    </div>
  );
}
