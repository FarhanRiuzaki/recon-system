"use client";

import { useMemo } from "react";
import Link from "next/link";
import { BlockedButton, ColumnsMenu, DataTable, FilterLayout, FilterSearch, FilterSurface, Notice, Panel, StatTile, StatTiles, StatTileSkeletons, Toolbar } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { CheckIcon, DiskIcon, EditIcon, TimeIcon, WarningIcon } from "@starterkit/ui/ui/icons";
import { formatNumber } from "@starterkit/ui/lib/format";
import { Reveal } from "@starterkit/ui/motion";
import type { SourceStateFilter } from "@starterkit/shared/sources";
import type { SourceRowDto } from "@starterkit/shared/contracts/sources";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { PageHeader } from "@/components/shell/page-header";
import { errorText } from "@/lib/client/api";
import { useTableQuery } from "@/lib/client/use-table-query";
import { SOURCES, type SourceFilters } from "@/lib/shared/queries";
import { SOURCE_LEGEND } from "@/lib/shared/source-status";
import { sourceColumns } from "./source-columns";
import { NEW_SOURCE_REASON, newSourceHref, useSourceSummary, useSpaceRoles } from "./use-sources";

const FILTER_DEFAULTS: SourceFilters = { q: "", state: "" };
/** The summary tiles (Figma 02 Sources v1.0.6), in order; each filters the list to its state. */
const TILES: { state: SourceStateFilter; label: string; caption: string; icon: typeof CheckIcon }[] = [
  { state: "healthy", label: "Healthy", caption: "Ingesting on time", icon: CheckIcon },
  { state: "attention", label: "Needs attention", caption: "Degraded or down", icon: WarningIcon },
  { state: "paused", label: "Paused", caption: "Waiting for a new approved version", icon: TimeIcon },
  { state: "draft", label: "Drafts", caption: "Not ingesting yet", icon: EditIcon },
];
const STATE_LABEL = Object.fromEntries(TILES.map((t) => [t.state, t.label])) as Record<SourceStateFilter, string>;
const FILTER_FIELDS = [{ key: "q", label: "Search" }, { key: "state", label: "State", format: (v: string) => STATE_LABEL[v as SourceStateFilter] ?? v }] as const;

/**
 * A space's sources (Figma 17:5543 / 31:8132): its own and those shared to it, each with the health the API judged for
 * the business date in progress (page.tsx has checked the viewer holds a role in the space and prefetched the first
 * page). Create source opens the wizard for a source admin; anyone else gets the reason.
 */
export function SourcesPage({ spaceId }: { spaceId: string }) {
  const def = useMemo(() => SOURCES(spaceId), [spaceId]);
  const columns = useMemo(() => sourceColumns(spaceId), [spaceId]);
  const t = useTableQuery<SourceRowDto, SourceFilters>(def);
  const summary = useSourceSummary(spaceId).data;
  const admin = useSpaceRoles(spaceId).includes("source_admin");
  const add = admin
    ? <Button variant="create-solid" asChild><Link href={newSourceHref(spaceId)}>Create source</Link></Button>
    : <BlockedButton variant="create-solid" reason={NEW_SOURCE_REASON}>Create source</BlockedButton>;
  return (
    <div className="grid gap-section">
      <PageHeader title="Sources" actions={add}
        description="The sources the recons of this space read." />
      {/* the KPI tray inside the filter surface: one width with the list under it (SO1) */}
      <FilterSurface>
      <Reveal loading={!summary} skeleton={<StatTiles><StatTileSkeletons count={4} /></StatTiles>}>
        {summary && (
          <StatTiles>
            {TILES.map((tile) => (
              <StatTile key={tile.state} icon={tile.icon} label={tile.label} value={formatNumber(summary[tile.state])} caption={tile.caption}
                selected={t.state.state === tile.state} onSelect={() => t.set({ state: t.state.state === tile.state ? "" : tile.state })} />
            ))}
          </StatTiles>
        )}
      </Reveal>
      {t.staleError && <Notice tone="warn" live>Couldn&apos;t refresh the sources; showing the ones loaded before. {errorText(t.staleError)}</Notice>}
      {t.viewNotRemembered && <Notice>This filter selection works at this URL, but is too long to remember in navigation. Save a named view to reopen it.</Notice>}
      <FilterLayout busy={t.paging.busy} values={{ q: t.state.q, state: t.state.state }} defaults={FILTER_DEFAULTS} fields={FILTER_FIELDS}
        onApply={(values, options) => t.set(values, options)} filters={(draft, patch) =>
          <FilterSearch label="Search sources" value={draft.q} onChange={q => patch({ q })} placeholder="Name or code" />}>
      {({ summary }) => <Panel toolbar={<Toolbar end={<><SavedViewsMenu /><ColumnsMenu columns={columns} hidden={t.hidden} onChange={t.setHidden} /></>}>{null}</Toolbar>}
        flush icon={DiskIcon} title="All sources" count={t.count} legend={SOURCE_LEGEND}>
        {summary}
        <DataTable label="Sources" rowHeight="identity" columns={columns} hidden={t.hidden} rows={t.rows} rowKey={(s) => s.id} loading={t.loading}
          sort={t.sort} onSortChange={t.onSortChange} paging={t.paging}
          error={t.loadError ? { title: "Couldn't load sources", cause: errorText(t.loadError), onRetry: () => void t.query.refetch() } : null}
          empty={t.state.q || t.state.state
            ? { icon: DiskIcon, title: "No sources match", description: "Change the search or the state, or clear them to see every source." }
            : { icon: DiskIcon, title: "No sources yet", description: "Sources appear here once a source admin adds one, or another space shares one with this space." }} />
      </Panel>}
      </FilterLayout>
      </FilterSurface>
    </div>
  );
}
