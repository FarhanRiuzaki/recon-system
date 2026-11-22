"use client";

import { useMemo } from "react";
import { ColumnsMenu, DataTable, FilterChecks, FilterLayout, FilterSearch, FilterSurface, Notice, Panel, Toolbar } from "@starterkit/ui/ds";
import { SuccessIcon } from "@starterkit/ui/ui/icons";
import { APPROVAL_KIND_LABEL, APPROVAL_KINDS } from "@starterkit/shared/approvals";
import type { ApprovalRowDto } from "@starterkit/shared/contracts/approvals";
import { SavedViewsMenu } from "@/components/saved-views-menu";
import { PageHeader } from "@/components/shell/page-header";
import { errorText } from "@/lib/client/api";
import { useTableQuery } from "@/lib/client/use-table-query";
import { APPROVALS, type ApprovalFilters } from "@/lib/shared/queries";
import { approvalColumns } from "./approval-columns";

const FILTER_DEFAULTS: ApprovalFilters = { q: "", kind: "", mine: "" };
const MINE_LABEL = "Waiting for my decision";
const kindLabel = (v: string) => APPROVAL_KIND_LABEL[v as keyof typeof APPROVAL_KIND_LABEL] ?? v;
const FILTER_FIELDS = [{ key: "q", label: "Search" }, { key: "mine", label: "Show", format: () => MINE_LABEL }, { key: "kind", label: "Kind", multiple: true, format: kindLabel }] as const;
const KIND_OPTIONS = APPROVAL_KINDS.map((k) => ({ value: k, label: APPROVAL_KIND_LABEL[k] }));

/**
 * A space's approvals inbox (spec §11 maker-checker), server-paged, waiting longest first: each request opens the
 * version's own review, where a config checker who didn't work on it approves or rejects it.
 */
export function ApprovalsPage({ spaceId, spaceName }: { spaceId: string; spaceName: string }) {
  const def = useMemo(() => APPROVALS(spaceId), [spaceId]);
  const columns = useMemo(() => approvalColumns(spaceId), [spaceId]);
  const t = useTableQuery<ApprovalRowDto, ApprovalFilters>(def);
  const filtered = !!(t.state.q || t.state.kind || t.state.mine);
  return (
    <div className="grid gap-section">
      <PageHeader title="Approvals" description="Source and recon versions sent for approval in this space." />
      <FilterSurface>
      {t.staleError && <Notice tone="warn" live>Couldn&apos;t refresh the approvals; showing the ones loaded before. {errorText(t.staleError)}</Notice>}
      {t.viewNotRemembered && <Notice>This filter selection works at this URL, but is too long to remember in navigation. Save a named view to reopen it.</Notice>}
      <FilterLayout busy={t.paging.busy} values={{ q: t.state.q, kind: t.state.kind, mine: t.state.mine }} defaults={FILTER_DEFAULTS} fields={FILTER_FIELDS}
        onApply={(values, options) => t.set(values, options)} filters={(draft, patch) => <>
          <FilterSearch label="Search approvals" value={draft.q} onChange={(q) => patch({ q })} placeholder="Name or code" />
          <FilterChecks label="Show" value={draft.mine} options={[{ value: "1", label: MINE_LABEL }]} onChange={(mine) => patch({ mine: mine ? "1" : "" })} />
          <FilterChecks label="Kind" value={draft.kind} options={KIND_OPTIONS} onChange={(kind) => patch({ kind })} />
        </>}>
      {({ summary }) => <Panel toolbar={<Toolbar end={<><SavedViewsMenu /><ColumnsMenu columns={columns} hidden={t.hidden} onChange={t.setHidden} /></>}>{null}</Toolbar>}
        flush icon={SuccessIcon} title={`Waiting in ${spaceName}`} count={t.count}>
        {summary}
        <DataTable label="Approvals" rowHeight="identity" columns={columns} hidden={t.hidden} rows={t.rows} rowKey={(r) => r.id} loading={t.loading}
          sort={t.sort} onSortChange={t.onSortChange} paging={t.paging}
          error={t.loadError ? { title: "Couldn't load approvals", cause: errorText(t.loadError), onRetry: () => void t.query.refetch() } : null}
          empty={filtered
            ? t.state.mine && !t.state.q && !t.state.kind
              ? { icon: SuccessIcon, title: "Nothing waiting for your decision", description: "A request appears here when someone else sends a version and you are a config checker of this space." }
              : { icon: SuccessIcon, title: "No approvals match", description: "Change the filters, or clear them to see every request." }
            : { icon: SuccessIcon, title: "Nothing waiting", description: "A request appears here when someone sends a source or recon version for approval." }} />
      </Panel>}
      </FilterLayout>
      </FilterSurface>
    </div>
  );
}
