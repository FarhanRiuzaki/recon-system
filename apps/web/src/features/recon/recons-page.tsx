"use client";

import { useMemo } from "react";
import Link from "next/link";
import { BlockedButton, ColumnsMenu, DataTable, FilterLayout, FilterSearch, FilterSurface, Notice, Panel, Toolbar } from "@starterkit/ui/ds";
import { Button } from "@starterkit/ui/ui/button";
import { NetworkIcon } from "@starterkit/ui/ui/icons";
import type { ReconRowDto } from "@starterkit/shared/contracts/recon";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { PageHeader } from "@/components/shell/page-header";
import { errorText } from "@/lib/client/api";
import { useTableQuery } from "@/lib/client/use-table-query";
import { RECONS } from "@/lib/shared/queries";
import { RECON_LEGEND } from "@/lib/shared/recon-status";
import { type LiveIndex, reconColumns } from "./recon-columns";
import { NEW_RECON_REASON, newReconHref, useSpaceRoles, useToday } from "./use-recons";

const FILTER_DEFAULTS = { q: "" };
const FILTER_FIELDS = [{ key: "q", label: "Search" }] as const;

/**
 * A space's recons, server-paged (page.tsx has checked the viewer holds a role in the space and prefetched the first
 * page). Create recon opens the create form for a config maker; anyone else gets the reason.
 */
export function ReconsPage({ spaceId, spaceName }: { spaceId: string; spaceName: string }) {
  const def = useMemo(() => RECONS(spaceId), [spaceId]);
  // the live columns read Today (the recons' current days and their sources), joined by id
  const today = useToday(spaceId).data;
  const live = useMemo((): LiveIndex | null => today ? { recons: new Map(today.recons.map((r) => [r.id, r])), sources: new Map(today.sources.map((s) => [s.id, s])) } : null, [today]);
  const columns = useMemo(() => reconColumns(spaceId, live), [spaceId, live]);
  const t = useTableQuery<ReconRowDto, { q: string }>(def);
  const maker = useSpaceRoles(spaceId).includes("config_maker");
  const add = maker
    ? <Button asChild><Link href={newReconHref(spaceId)}>Create recon</Link></Button>
    : <BlockedButton reason={NEW_RECON_REASON}>Create recon</BlockedButton>;
  return (
    <div className="grid gap-section">
      <PageHeader title="Recons" actions={add}
        description="The recons of this space, each matching the records of two sources." />
      <FilterSurface>
      {t.staleError && <Notice tone="warn" live>Couldn&apos;t refresh the recons; showing the ones loaded before. {errorText(t.staleError)}</Notice>}
      {t.viewNotRemembered && <Notice>This filter selection works at this URL, but is too long to remember in navigation. Save a named view to reopen it.</Notice>}
      <FilterLayout busy={t.paging.busy} values={{ q: t.state.q }} defaults={FILTER_DEFAULTS} fields={FILTER_FIELDS}
        onApply={(values, options) => t.set(values, options)} filters={(draft, patch) =>
          <FilterSearch label="Search recons" value={draft.q} onChange={q => patch({ q })} placeholder="Name or code" />}>
      {({ summary }) => <Panel toolbar={<Toolbar end={<><SavedViewsMenu /><ColumnsMenu columns={columns} hidden={t.hidden} onChange={t.setHidden} /></>}>{null}</Toolbar>}
        flush icon={NetworkIcon} title={`Recons in ${spaceName}`} count={t.count} legend={RECON_LEGEND}>
        {summary}
        <DataTable label="Recons" rowHeight="identity" columns={columns} hidden={t.hidden} rows={t.rows} rowKey={(r) => r.id} loading={t.loading}
          sort={t.sort} onSortChange={t.onSortChange} paging={t.paging}
          error={t.loadError ? { title: "Couldn't load recons", cause: errorText(t.loadError), onRetry: () => void t.query.refetch() } : null}
          empty={t.state.q
            ? { icon: NetworkIcon, title: "No recons match", description: "Change the search, or clear it to see every recon." }
            : { icon: NetworkIcon, title: "No recons yet", description: "Recons appear here once a config maker creates one from two of this space's sources." }} />
      </Panel>}
      </FilterLayout>
      </FilterSurface>
    </div>
  );
}
